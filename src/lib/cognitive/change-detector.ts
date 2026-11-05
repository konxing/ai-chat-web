import type {
  MemoryOrigin as DbMemoryOrigin,
  MemoryType as DbMemoryType,
  TimePrecision as DbTimePrecision
} from '@prisma/client';
import { toDbMemoryOrigin, toDbTimePrecision, type MemoryDto } from './memories';
import { toDbMemoryType } from './policy';
import type { TimelineEdge } from './timeline';
import {
  COMPLETION_MARKERS,
  INTEREST_SHIFT_MEDIAN_GAP_DAYS,
  INTEREST_SHIFT_MIN_SAMPLES,
  PATTERN_MIN_CHATS,
  PATTERN_MIN_SAMPLES,
  PATTERN_MIN_SPAN_DAYS,
  UNRESOLVED_MIN_AGE_DAYS,
  UNRESOLVED_QUIET_DAYS,
  buildClusters,
  daysBetween,
  statsOf,
  topicSignature,
  type Cluster,
  type InsufficientReason,
  type ReflectableMemory
} from './reflection-planner';

/**
 * 变化检测（任务书 4.3 的 ChangeDetector）。
 *
 * 这一层只产出**观察**：哪几行之间出现了一次变化、支撑它的是几条样本、跨了多少天、
 * 出处是哪些行。一个判断性句子都不写——措辞在 `change-display.ts` 的封闭句式表里，
 * 因为「偏好变了」和「用户的性格变了」之间的界线，就是这一层有没有把推断写成结论。
 * 任务书在这一节明令：不许根据极少数记录预测用户未来人生、不许生成确定性人格结论。
 *
 * 零模型调用、零数据库、零 crypto：输入是调用方已经解密好的行，所以每一条规则都能逐行断言。
 *
 * 六件事分两条路走：
 *
 * ②目标状态变化、③项目进展、④偏好变化 走**版本链**。演化边是写侧（Phase 2C 改口接线）
 * 判过「这两句说的是同一件事」才留下的，这一层继承那个判断，不重做词法相似度——
 * 4-T3 量过，相似度在中文语料上 0/36，重做一遍就是把已知的死路再走一次。
 *
 * ①兴趣出现和变化、⑤长期重复主题、⑥长时间未解决的事项 走**主题簇**，
 * 用的是 6.1 那把尺子：同一个分词、同一个 `TOPIC_MIN_OVERLAP`、同一组门槛常量。
 * 一个概念在本仓库里有两套算法，早晚会长成「洞察说在重复、时间线说不是」——
 * 那种互相矛盾不是 bug，是同一个用户同一天看到两个世界。
 *
 * 枚举词汇有两套，这里用的是**界面那套小写**（`MemoryDto` / `TimelineEdge`），
 * 转成 prisma 大写之后交给 6.1 的簇算法；比较失效与否都在大写侧。
 * 抄成小写比较就是永远为真（`isActive` 判的是 `'RETRACTED'`）。
 *
 * 测试：tests/unit/cognitive-change-detector.test.ts
 */

const DAY_MS = 86_400_000;

/** 观察的六个主题，对应任务书 4.3 列的六件事。封闭集合：加一类而措辞层没给句子，编译就过不去。 */
export const CHANGE_SUBJECTS = ['INTEREST', 'GOAL', 'PROJECT', 'PREFERENCE', 'REPETITION', 'UNRESOLVED'] as const;
export type ChangeSubject = (typeof CHANGE_SUBJECTS)[number];

/** 每个主题下检测到的信号。① 有 EMERGED/SHIFTED，② 有 CHANGED/COMPLETED/WITHDRAWN，依此类推。 */
export const CHANGE_SIGNALS = [
  'EMERGED',
  'SHIFTED',
  'CHANGED',
  'COMPLETED',
  'WITHDRAWN',
  'UPDATED',
  'RECURRING',
  'STILL_OPEN'
] as const;
export type ChangeSignal = (typeof CHANGE_SIGNALS)[number];

/**
 * 差在哪条门槛。复用 6.1 的理由集合，去掉 DECISION_LESSON 专用的那一条：
 * 决策经验属于 Phase 7，不在 4.3 的六件事里。
 */
export type InsufficientChangeReason = Exclude<InsufficientReason, 'BELOW_OUTCOME_MIN'>;

/** 版本链要跨几个会话才算「变化」。同一会话里改两次口是一次讨论，不是一种变化。 */
export const CHAIN_MIN_CHATS = 2;
/** 「新出现」的时间窗：簇里最早的那句离现在超过这么多天，就不叫新出现了。 */
export const INTEREST_EMERGED_WINDOW_DAYS = 30;

const CONFIRMED_ORIGINS: ReadonlySet<string> = new Set([
  toDbMemoryOrigin('explicit'),
  toDbMemoryOrigin('userConfirmed')
]);
/** 「兴趣」在库里没有对应的记忆类型。① 只由「偏好＋目标」两类行代表——这个局限要如实写进界面文案。 */
const INTEREST_TYPES: ReadonlySet<string> = new Set([toDbMemoryType('preference'), toDbMemoryType('goal')]);
/** 版本链只服务 ②③④：库里其余类型的演化不属于 4.3 列的六件事。 */
const CHAIN_SUBJECTS: Partial<Record<DbMemoryType, ChangeSubject>> = {
  GOAL: 'GOAL',
  PROJECT: 'PROJECT',
  PREFERENCE: 'PREFERENCE'
};

/** 一条被规则认定的变化。没有标题、没有正文：那是措辞层的活。 */
export interface ChangeObservation {
  subject: ChangeSubject;
  change: ChangeSignal;
  /** 讲的是哪件事：主题词取自新那一版（或簇的共有签名），不是正文。 */
  topicTokens: string[];
  /** 变化前的那些行。撤回、刚出现时各有一侧是空。 */
  beforeMemoryIds: string[];
  afterMemoryIds: string[];
  /** 任务书点名要的两列：样本数量、观察时间跨度。 */
  sampleCount: number;
  observationSpanDays: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 来自记录时刻的就是 TIMESTAMP；来自某条记忆 validFrom 的跟着那条的精度走。 */
  timePrecision: DbTimePrecision;
  /** 支撑它的句子里有没有用户说过或确认过的那一类来源。 */
  confirmed: boolean;
}

/**
 * 差多少证据、差在哪条门槛。和 6.1 的 insufficient 一样刻意不带主题词：
 * 这一条结构是要能整包进日志的，而日志里不许出现用户正文的切片。
 */
export interface InsufficientChange {
  subject: ChangeSubject;
  reason: InsufficientChangeReason;
  sampleCount: number;
  observationSpanDays: number;
}

export interface ChangeSource {
  /** 从外面传进来：规则里全是「隔了多少天」，用系统时钟的测试过几天会自己变红。 */
  now: Date;
  memories: readonly MemoryDto[];
  edges: readonly TimelineEdge[];
}

export interface ChangeReport {
  observations: ChangeObservation[];
  insufficient: InsufficientChange[];
}

export function detectChanges({ now, memories, edges }: ChangeSource): ChangeReport {
  const rows = new Map<string, MemoryDto>();
  for (const row of memories) {
    if (!row.id || rows.has(row.id)) continue;
    rows.set(row.id, row);
  }
  if (rows.size === 0) return { observations: [], insufficient: [] };

  const byId = new Map<string, ReflectableMemory>();
  for (const row of rows.values()) byId.set(row.id, toReflectable(row));
  const all = [...byId.values()];

  const observations: ChangeObservation[] = [];
  const insufficient: InsufficientChange[] = [];

  collectChainChanges({ now, byId, edges, observations, insufficient });
  const clusters = buildClusters(all);
  collectRepetitions(clusters, observations, insufficient);
  collectUnresolved(clusters, now, observations, insufficient);
  collectInterest(buildClusters(all.filter((memory) => INTEREST_TYPES.has(memory.type))), now, observations, insufficient);

  return {
    observations: observations.sort(compareObservations),
    insufficient: insufficient.sort(
      (left, right) => left.subject.localeCompare(right.subject) || left.reason.localeCompare(right.reason)
    )
  };
}

/**
 * 界面那一套小写枚举 → 6.1 算法要的那套大写。
 * 转换只有这一处，所以「簇」「签名」「失效判断」两边看到的字面量必然一致。
 */
function toReflectable(row: MemoryDto): ReflectableMemory {
  return {
    id: row.id,
    text: row.content,
    type: toDbMemoryType(row.type),
    origin: toDbMemoryOrigin(row.origin),
    chatId: row.chatId,
    recordedAt: new Date(row.recordedAt),
    validFrom: row.validFrom ? new Date(row.validFrom) : null,
    validPrecision: toDbTimePrecision(row.precision),
    supersededAt: row.supersededAt ? new Date(row.supersededAt) : null
  };
}

interface Collector {
  now: Date;
  byId: Map<string, ReflectableMemory>;
  edges: readonly TimelineEdge[];
  observations: ChangeObservation[];
  insufficient: InsufficientChange[];
}

/** ②③④：沿着演化边逐条看。一条边就是写侧确认过的一次改口或一次撤回。 */
function collectChainChanges({ byId, edges, observations, insufficient }: Collector): void {
  const ordered = [...edges].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.memoryId.localeCompare(right.memoryId)
  );
  for (const revision of ordered) {
    const next = byId.get(revision.memoryId);
    if (!next) continue;
    const subject = CHAIN_SUBJECTS[next.type];
    if (!subject) continue;

    // 撤回只有一句话，没有「后」的一版说法：那一行放在变化前，之后什么都没有。
    // 它不过会话门槛——同一句被用户自己收回，跟几句一起说没关系。
    if (revision.action === 'retracted') {
      observations.push({
        subject,
        change: 'WITHDRAWN',
        topicTokens: topicSignature(next.text),
        beforeMemoryIds: [next.id],
        afterMemoryIds: [],
        sampleCount: 1,
        observationSpanDays: 0,
        firstSeenAt: next.recordedAt.toISOString(),
        lastSeenAt: next.recordedAt.toISOString(),
        timePrecision: 'TIMESTAMP',
        confirmed: CONFIRMED_ORIGINS.has(next.origin)
      });
      continue;
    }

    const previous = revision.previousId ? byId.get(revision.previousId) : undefined;
    // 边指向这一批里没有的行：那叫幽灵引用，跳过整条边。
    // 也不落进 insufficient——那个结构回答的是「差在哪条门槛」，读不到的行不是门槛问题。
    if (!previous) continue;

    const first = new Date(Math.min(previous.recordedAt.getTime(), next.recordedAt.getTime()));
    const last = new Date(Math.max(previous.recordedAt.getTime(), next.recordedAt.getTime()));
    const spanDays = daysBetween(last, first);
    const chats = new Set([previous.chatId, next.chatId].filter((chatId): chatId is string => chatId !== null));
    if (chats.size < CHAIN_MIN_CHATS) {
      insufficient.push({ subject, reason: 'BELOW_CHAT_MIN', sampleCount: 2, observationSpanDays: spanDays });
      continue;
    }
    observations.push({
      subject,
      change: chainSignal(subject, next),
      topicTokens: topicSignature(next.text),
      beforeMemoryIds: [previous.id],
      afterMemoryIds: [next.id],
      sampleCount: 2,
      observationSpanDays: spanDays,
      firstSeenAt: first.toISOString(),
      lastSeenAt: last.toISOString(),
      // 链侧的两个时刻都是「记录时间」：改口发生在今天，跟用户话里的「去年」无关。
      timePrecision: 'TIMESTAMP',
      confirmed: CONFIRMED_ORIGINS.has(previous.origin) || CONFIRMED_ORIGINS.has(next.origin)
    });
  }
}

/** 完成说法只看新那一版——旧说法里带过一句「做完了」不算到达。项目不借用它：③ 要的是进展。 */
function chainSignal(subject: ChangeSubject, next: ReflectableMemory): ChangeSignal {
  if (subject === 'GOAL') {
    return COMPLETION_MARKERS.some((marker) => next.text.includes(marker)) ? 'COMPLETED' : 'CHANGED';
  }
  return subject === 'PROJECT' ? 'UPDATED' : 'CHANGED';
}

/** ⑤：跨会话、跨时间地反复提到同一件事。门槛全部复用 6.1 的 PATTERN 常量，不在这里另写数。 */
function collectRepetitions(clusters: readonly Cluster[], observations: ChangeObservation[], insufficient: InsufficientChange[]): void {
  for (const cluster of clusters) {
    if (cluster.active.length < 2) continue;
    const { spanDays, chatCount, lastRecordedAt } = statsOf(cluster.active);
    const sampleCount = cluster.active.length;
    if (sampleCount >= PATTERN_MIN_SAMPLES && chatCount >= PATTERN_MIN_CHATS && spanDays >= PATTERN_MIN_SPAN_DAYS) {
      observations.push({
        subject: 'REPETITION',
        change: 'RECURRING',
        topicTokens: cluster.core,
        beforeMemoryIds: cluster.inactive.map((memory) => memory.id),
        afterMemoryIds: cluster.active.map((memory) => memory.id),
        sampleCount,
        observationSpanDays: spanDays,
        firstSeenAt: cluster.active[0]!.recordedAt.toISOString(),
        lastSeenAt: lastRecordedAt.toISOString(),
        timePrecision: 'TIMESTAMP',
        confirmed: cluster.active.some((memory) => CONFIRMED_ORIGINS.has(memory.origin))
      });
      continue;
    }
    const reason: InsufficientChangeReason =
      sampleCount < PATTERN_MIN_SAMPLES
        ? 'BELOW_SAMPLE_MIN'
        : chatCount < PATTERN_MIN_CHATS
          ? 'BELOW_CHAT_MIN'
          : 'BELOW_SPAN_MIN';
    insufficient.push({ subject: 'REPETITION', reason, sampleCount, observationSpanDays: spanDays });
  }
}

/** ⑥：目标放了很久，而这阵子同主题一句都没有。只报每个簇里最早的那一条。 */
function collectUnresolved(
  clusters: readonly Cluster[],
  now: Date,
  observations: ChangeObservation[],
  insufficient: InsufficientChange[]
): void {
  for (const cluster of clusters) {
    const goals = cluster.active.filter((memory) => memory.type === 'GOAL');
    if (goals.length === 0) continue;
    const goal = goals[0]!;
    const sampleCount = cluster.active.length;
    const ageDays = daysBetween(now, goal.recordedAt);
    if (ageDays < UNRESOLVED_MIN_AGE_DAYS) {
      insufficient.push({
        subject: 'UNRESOLVED',
        reason: 'BELOW_AGE_MIN',
        sampleCount,
        observationSpanDays: statsOf(cluster.active).spanDays
      });
      continue;
    }
    const quietSince = new Date(now.getTime() - UNRESOLVED_QUIET_DAYS * DAY_MS);
    // 这阵子还在说同一件事：那不是没下文，是有下文。静默不成理由，也不落进 insufficient。
    if (cluster.active.some((memory) => memory.recordedAt > quietSince)) continue;
    // 起点跟着那条目标自己的精度走，终点是「现在」这个系统时刻。
    const from = goal.validFrom ?? goal.recordedAt;
    observations.push({
      subject: 'UNRESOLVED',
      change: 'STILL_OPEN',
      topicTokens: cluster.core,
      beforeMemoryIds: cluster.inactive.map((memory) => memory.id),
      afterMemoryIds: [goal.id],
      sampleCount,
      observationSpanDays: daysBetween(now, from),
      firstSeenAt: from.toISOString(),
      lastSeenAt: now.toISOString(),
      timePrecision: goal.validFrom ? goal.validPrecision : 'TIMESTAMP',
      confirmed: CONFIRMED_ORIGINS.has(goal.origin)
    });
  }
}

/**
 * ①：兴趣的出现与转移。先判转移——一次移动只说一遍，
 * 所以进了 SHIFTED 的那两个簇不再各自报一次「新出现」。
 */
function collectInterest(
  clusters: readonly Cluster[],
  now: Date,
  observations: ChangeObservation[],
  insufficient: InsufficientChange[]
): void {
  const shiftedPair = pickInterestShift(clusters, insufficient);
  const shifted = new Set<Cluster>(shiftedPair ? [shiftedPair.older, shiftedPair.newer] : []);
  collectInterestEmergences(clusters, now, shifted, observations);
  if (!shiftedPair) return;

  const { older, newer } = shiftedPair;
  const members = [...older.active, ...newer.active];
  const times = members.map((memory) => memory.recordedAt.getTime());
  observations.push({
    subject: 'INTEREST',
    change: 'SHIFTED',
    topicTokens: [...new Set([...older.core, ...newer.core])].sort(),
    beforeMemoryIds: older.active.map((memory) => memory.id),
    afterMemoryIds: newer.active.map((memory) => memory.id),
    sampleCount: members.length,
    observationSpanDays: daysBetween(new Date(Math.max(...times)), new Date(Math.min(...times))),
    firstSeenAt: new Date(Math.min(...times)).toISOString(),
    lastSeenAt: new Date(Math.max(...times)).toISOString(),
    timePrecision: 'TIMESTAMP',
    confirmed: members.some((memory) => CONFIRMED_ORIGINS.has(memory.origin))
  });
}

/** 转移的判据与 6.1 的 INTEREST_SHIFT 逐条同构：样本够、中位数够远，两者缺一就不说「被替换」。 */
function pickInterestShift(
  clusters: readonly Cluster[],
  insufficient: InsufficientChange[]
): { older: Cluster; newer: Cluster } | null {
  const medianOf = (cluster: Cluster): number => {
    const times = cluster.active.map((memory) => memory.recordedAt.getTime()).sort((left, right) => left - right);
    return times[Math.floor(times.length / 2)] ?? 0;
  };
  const usable = clusters.filter((cluster) => cluster.active.length >= 1);
  if (usable.length < 2) return null;

  const ordered = [...usable].sort((left, right) => medianOf(right) - medianOf(left));
  const newer = ordered[0]!;
  const newerMedian = medianOf(newer);
  if (newer.active.length < INTEREST_SHIFT_MIN_SAMPLES) {
    insufficient.push({
      subject: 'INTEREST',
      reason: 'BELOW_SAMPLE_MIN',
      sampleCount: newer.active.length,
      observationSpanDays: statsOf(newer.active).spanDays
    });
    return null;
  }

  const candidates = ordered
    .slice(1)
    .filter((cluster) => newerMedian - medianOf(cluster) >= INTEREST_SHIFT_MEDIAN_GAP_DAYS * DAY_MS);
  if (candidates.length === 0) {
    insufficient.push({
      subject: 'INTEREST',
      reason: 'BELOW_MEDIAN_GAP',
      sampleCount: newer.active.length,
      observationSpanDays: statsOf(newer.active).spanDays
    });
    return null;
  }
  const older = [...candidates].sort(
    (left, right) => right.active.length - left.active.length || medianOf(left) - medianOf(right)
  )[0]!;
  if (older.active.length < INTEREST_SHIFT_MIN_SAMPLES) {
    insufficient.push({
      subject: 'INTEREST',
      reason: 'BELOW_SAMPLE_MIN',
      sampleCount: older.active.length,
      observationSpanDays: statsOf(older.active).spanDays
    });
    return null;
  }
  return { older, newer };
}

/**
 * 「新出现」的门槛：够样本、够跨会话、而且簇里最早的那句就在最近。
 * 不成立时静默跳过——① 没有「差在哪条门槛」的语义（近期内没成簇就是没有新东西出现，
 * 这不叫证据不足），而 ⑤ 那边已经把同一批行的证据情况报出去了。
 */
function collectInterestEmergences(
  clusters: readonly Cluster[],
  now: Date,
  skip: ReadonlySet<Cluster>,
  observations: ChangeObservation[]
): void {
  for (const cluster of clusters) {
    if (skip.has(cluster)) continue;
    if (cluster.active.length < PATTERN_MIN_SAMPLES) continue;
    const { spanDays, chatCount, lastRecordedAt } = statsOf(cluster.active);
    if (chatCount < PATTERN_MIN_CHATS) continue;
    const earliest = cluster.active[0]!.recordedAt;
    if (daysBetween(now, earliest) > INTEREST_EMERGED_WINDOW_DAYS) continue;
    observations.push({
      subject: 'INTEREST',
      change: 'EMERGED',
      topicTokens: cluster.core,
      beforeMemoryIds: [],
      afterMemoryIds: cluster.active.map((memory) => memory.id),
      sampleCount: cluster.active.length,
      observationSpanDays: spanDays,
      firstSeenAt: earliest.toISOString(),
      lastSeenAt: lastRecordedAt.toISOString(),
      timePrecision: 'TIMESTAMP',
      confirmed: cluster.active.some((memory) => CONFIRMED_ORIGINS.has(memory.origin))
    });
  }
}

function compareObservations(left: ChangeObservation, right: ChangeObservation): number {
  if (left.firstSeenAt !== right.firstSeenAt) return left.firstSeenAt < right.firstSeenAt ? -1 : 1;
  if (left.subject !== right.subject) return left.subject.localeCompare(right.subject);
  return left.change.localeCompare(right.change);
}
