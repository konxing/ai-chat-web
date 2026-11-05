import { createHash } from 'node:crypto';
import type {
  DecisionStatus,
  MemoryOrigin,
  MemoryRevisionAction,
  MemoryType,
  ReflectionType,
  TimePrecision
} from '@prisma/client';
import { tokenize } from './retrieval';

/**
 * 反思规划层（任务书 6.2 的 ReflectionPlanner、6.1 的七类、6.3 的多假设、6.6 的「不许重复生成」）。
 *
 * 这一层只回答「池子里有没有一件值得说的事」，一个中文字都不写：措辞全在 6-C。
 * 理由是文本只能有一个出处——一边在规划层写「你可能……」，一边在渲染层写「你会……」，
 * 最后落库的是哪一句取决于谁后跑，而这种错没人能从代码里读出来。
 *
 * 零模型调用。七类的判据都是「读进去的那几行行」，所以门槛 4（证据可追溯）和门槛 5
 * （高置信度不许有无来源的确定事实）在这里是按构造成立的，不是靠事后校验。
 *
 * 输入是调用方已经解密好的行：这一层不碰数据库、不碰 crypto，因此可以逐条断言。
 * 时间从外面传进来（now）：规则里全是「隔了多少天」，用系统时钟的测试过几天会自己变红。
 *
 * 测试：tests/unit/cognitive-reflection-planner.test.ts
 */

/** 主题重合至少几个词才算同一件事。1 个太松（一个「项目」就能把八条记忆连成一团）。 */
export const TOPIC_MIN_OVERLAP = 2;
export const PATTERN_MIN_SAMPLES = 3;
/** 「反复提到」要跨会话：同一个会话里说三遍只是一次讨论，不是一种模式。 */
export const PATTERN_MIN_CHATS = 3;
export const PATTERN_MIN_SPAN_DAYS = 14;
export const UNRESOLVED_MIN_AGE_DAYS = 60;
/** 目标放了 60 天、但这 60 天里同主题一句都没有，才叫「没下文」。 */
export const UNRESOLVED_QUIET_DAYS = 60;
export const INTEREST_SHIFT_MIN_SAMPLES = 3;
export const INTEREST_SHIFT_MEDIAN_GAP_DAYS = 30;
/**
 * 一次扫描最多看这么多条。成簇是 O(n²)：500 条约一百万次集合比对，一天一次跑得动，
 * 五千条就会把后台那一轮拖到超时。超出的部分由调用方按最近优先截断。
 */
export const REFLECTION_POOL_LIMIT = 500;

const DAY_MS = 86_400_000;

/**
 * 第一人称 + 意向动词的开头串。抽取器只收第一人称陈述（memory-extractor.ts 那句「我」），
 * 于是这些串几乎每条记忆都带：留着它们，任意两条记忆都「同主题」，成簇就没有意义了。
 * 它们不是内容词，比重合之前先摘掉。
 */
const BOILERPLATE: readonly string[] = [
  '我打',
  '打算',
  '我准',
  '准备',
  '我计',
  '计划',
  '我把',
  '我在',
  '我有',
  '我想',
  '我要',
  '我不',
  '我的',
  '我是'
];

/** 否定标记。单字子串匹配，误判方向是「多找一对矛盾」，所以宁可窄。措辞层判反证用的是同一张表。 */
export const NEGATION_MARKERS: readonly string[] = ['不', '没', '无', '别'];

/**
 * 完成说法。MILESTONE 只认这些——「改成了 X」不是到达。
 *
 * 导出它是因为 4.3 的「目标状态变化」要用同一张表：一张表在两处各自维护，
 * 早晚会变成「洞察说到达了、时间线说只是变了」——那是同一个事实的两种说法。
 */
export const COMPLETION_MARKERS: readonly string[] = [
  '完成了',
  '搞定了',
  '上线了',
  '通过了',
  '考过了',
  '拿到了',
  '毕业了',
  '结项',
  '交付了',
  '做到了'
];

/** PATTERN 分不开 6.3 举例的那三种解释，于是一条都不选，把解释和各自缺的证据一起交出去。 */
export const PATTERN_HYPOTHESES = ['LONG_TERM_INTEREST', 'STAGED_PROJECT', 'TEMPORARY_LEARNING'] as const;
/** 键的封闭集合：加一种解释而措辞层没给它句子，编译就过不去。 */
export type PatternHypothesis = (typeof PATTERN_HYPOTHESES)[number];

export interface ReflectableMemory {
  id: string;
  /** 解密后的正文。只在这一层的内存里存在，不进任何日志、不进任何返回值。 */
  text: string;
  type: MemoryType;
  origin: MemoryOrigin;
  chatId: string | null;
  recordedAt: Date;
  validFrom: Date | null;
  validPrecision: TimePrecision;
  supersededAt: Date | null;
}

export interface ReflectableRevision {
  action: MemoryRevisionAction;
  /** 新版本。 */
  memoryId: string;
  /** 被取代的那一版；首版没有前驱，是 null。 */
  previousId: string | null;
  createdAt: Date;
}

export interface ReflectableDecision {
  id: string;
  status: DecisionStatus;
  topic: string;
  /** 用户确认这条候选的时刻；待确认的是 null。 */
  confirmedAt: Date | null;
  /** 关联到这条决策的、已确认结果的记录时刻；没有就是 null。 */
  outcomeRecordedAt: Date | null;
  /**
   * 用户话里「决定于」的那一天。这一列在下面任何规则里都不读：DecisionRecord 没有给它配
   *  精度列，「去年冬天」和「2026-03-11」在库里长得一样，拿它当精确日期就是门槛 6 不许的伪造。
   *  留在类型上是因为调用方递的就是整行，声明它才能把「带着也不用」这件事写成测试。
   */
  decidedAt?: Date | null;
}

export interface ReflectionPlanInput {
  now: Date;
  memories: readonly ReflectableMemory[];
  revisions?: readonly ReflectableRevision[];
  decisions?: readonly ReflectableDecision[];
}

/** 一条被规则认定的事。没有标题、没有正文——那是 6-C 的活。 */
export interface ReflectionFinding {
  type: ReflectionType;
  /** 6.6 的合并键：type + 主题词集的摘要。词集变了键就变，这是词法版去重的边界，不假装它能合并所有同主题。 */
  dedupKey: string;
  /** 反证搜索要用的关键词（6-C 消费）。 */
  topicTokens: string[];
  supportMemoryIds: string[];
  counterMemoryIds: string[];
  supportDecisionIds: string[];
  sampleCount: number;
  observationSpanDays: number;
  timeFrom: Date;
  timeTo: Date;
  /** 从 recordedAt 得来的区间就是 TIMESTAMP；从某条记忆的 validFrom 得来的，精度跟着那条记忆走。 */
  timePrecision: TimePrecision;
  hypothesisKeys: string[];
}

export type InsufficientReason =
  | 'BELOW_SAMPLE_MIN'
  | 'BELOW_CHAT_MIN'
  | 'BELOW_SPAN_MIN'
  | 'BELOW_AGE_MIN'
  | 'BELOW_MEDIAN_GAP'
  | 'BELOW_OUTCOME_MIN';

/**
 * 差多少证据、差在哪一条门槛。6-D 把它记成一条日志——所以这一条结构里刻意没有主题词：
 * `topicTokens` 是用户正文的切片，放进会落日志的结构里就是一个泄露口，而没有任何读侧需要它。
 * 用户问「为什么没有洞察」时，类型 + 计数 + 差在哪条门槛就是唯一诚实的答案。
 */
export interface InsufficientEvidence {
  type: ReflectionType;
  sampleCount: number;
  observationSpanDays: number;
  reason: InsufficientReason;
}

export interface ReflectionPlan {
  findings: ReflectionFinding[];
  insufficient: InsufficientEvidence[];
}

/**
 * 一个主题簇：活跃的行、失效的行、每行的主题词、活跃行共有的签名。
 * 导出给 4.3 的变化检测用——「同一件事」在这份仓库里只该有一把尺子。
 */
export interface Cluster {
  active: ReflectableMemory[];
  inactive: ReflectableMemory[];
  tokens: Set<string>[];
  /** 簇内所有活跃成员共有的词；主题签名。 */
  core: string[];
}

/**
 * 「跨了多少天」只有一个算法：四舍五入到整天。
 * 导出给 4.3 用，因为观察里的观察跨度要是用另一种取整，两条规则就会对同一批行报出两个跨度。
 */
export function daysBetween(later: Date, earlier: Date): number {
  return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / DAY_MS));
}

function isActive(memory: ReflectableMemory): boolean {
  return memory.supersededAt === null && memory.origin !== 'RETRACTED';
}

function topicTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => token.length >= 2 && !BOILERPLATE.includes(token)));
}

/** 一句话的主题签名（排过序、摘掉第一人称套话、只留两字以上的词）。4.3 的观察用它说「讲的是哪件事」。 */
export function topicSignature(text: string): string[] {
  return [...topicTokens(text)].sort();
}

/** 一组行的跨度、跨了几个会话、最后一条什么时候记的。4.3 的每一条观察都要带前两个数。 */
export function statsOf(active: readonly ReflectableMemory[]): { spanDays: number; chatCount: number; lastRecordedAt: Date } {
  const times = active.map((memory) => memory.recordedAt);
  const chats = new Set(active.map((memory) => memory.chatId).filter((chatId): chatId is string => chatId !== null));
  const first = new Date(Math.min(...times.map((time) => time.getTime())));
  const last = new Date(Math.max(...times.map((time) => time.getTime())));
  return { spanDays: daysBetween(last, first), chatCount: chats.size, lastRecordedAt: last };
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

/**
 * 这一句正文和那组主题词算不算「同一个话题」——用的就是成簇那把尺子（同一套分词、同一个
 * `TOPIC_MIN_OVERLAP`），不是第二套标准。
 *
 * 导出它只有一个消费者：6-E 的复活判据要说「用户拒绝之后又记进了同类的一句」。
 * 这条判断如果自己在 sweep 里重算一遍词，就会和成簇的口径慢慢漂移——
 * 同一个词表两处解释，正是 prisma-mock 文件头写着要避免的那种事。
 */
export function sharesTopicWith(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  return overlap(topicTokens(text), new Set(tokens)) >= TOPIC_MIN_OVERLAP;
}

function intersect(left: Set<string>, right: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const token of left) if (right.has(token)) out.add(token);
  return out;
}

/**
 * 成簇：对所有记忆（含已被取代和已撤回的）做并查集，两两重合 ≥ TOPIC_MIN_OVERLAP 就并到一起。
 * 把失效的行也放进去，是为了让反例留在同一个簇里——只按活跃记忆成簇的话，
 * 「你以前说过相反的话」这一类证据永远进不了 6-C 的视野。
 *
 * 导出它是为了让 4.3 用同一把尺子量「同一件事」。这份仓库里如果一个概念有两套算法，
 * 两套就会各自漂移，最后同一个用户在同一天看到两种互相矛盾的主题划分——
 * prisma-mock 文件头写的就是要避掉这种事。
 */
export function buildClusters(memories: readonly ReflectableMemory[]): Cluster[] {
  if (memories.length === 0) return [];
  const tokens = memories.map((memory) => topicTokens(memory.text));
  const parent = memories.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor]!;
    return cursor;
  };
  for (let left = 0; left < memories.length; left += 1) {
    for (let right = left + 1; right < memories.length; right += 1) {
      if (tokens[left]!.size === 0 || tokens[right]!.size === 0) continue;
      if (overlap(tokens[left]!, tokens[right]!) < TOPIC_MIN_OVERLAP) continue;
      const rootLeft = find(left);
      const rootRight = find(right);
      if (rootLeft !== rootRight) parent[rootRight] = rootLeft;
    }
  }

  const groups = new Map<number, number[]>();
  memories.forEach((_, index) => {
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket) bucket.push(index);
    else groups.set(root, [index]);
  });

  const clusters: Cluster[] = [];
  for (const indexes of groups.values()) {
    const members = indexes.map((index) => ({ memory: memories[index]!, tokens: tokens[index]! }));
    let core: Set<string> | null = null;
    for (const member of members) {
      core = core === null ? new Set(member.tokens) : intersect(core, member.tokens);
    }
    const active = members.filter((member) => isActive(member.memory)).map((member) => member.memory);
    const inactive = members.filter((member) => !isActive(member.memory)).map((member) => member.memory);
    // 活跃成员一个都不剩时，签名退回整簇共有词：这条簇还要用来找反例，但出不了洞察。
    const activeCore = active.length === 0 ? core! : active.reduce(
      (acc, memory) => intersect(acc, topicTokens(memory.text)),
      new Set(topicTokens(active[0]!.text))
    );
    clusters.push({
      active: sortByTime(active),
      inactive: sortByTime(inactive),
      tokens: members.map((member) => member.tokens),
      core: [...activeCore].sort()
    });
  }
  return clusters.sort((left, right) => left.core.join('|').localeCompare(right.core.join('|')));
}

function sortByTime(memories: ReflectableMemory[]): ReflectableMemory[] {
  return [...memories].sort((left, right) => {
    const byTime = left.recordedAt.getTime() - right.recordedAt.getTime();
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

function dedupKey(type: ReflectionType, tokens: readonly string[]): string {
  const digest = createHash('sha1').update(tokens.join('|')).digest('hex').slice(0, 16);
  return `${type}:${digest}`;
}

function finding(base: Omit<ReflectionFinding, 'dedupKey'>): ReflectionFinding {
  return { ...base, dedupKey: dedupKey(base.type, base.topicTokens) };
}

/** 6.1 PATTERN：跨会话、跨时间地反复提到同一件事。 */
function patternFindings(clusters: readonly Cluster[]): {
  findings: ReflectionFinding[];
  insufficient: InsufficientEvidence[];
} {
  const findings: ReflectionFinding[] = [];
  const insufficient: InsufficientEvidence[] = [];
  for (const cluster of clusters) {
    if (cluster.active.length < 2) continue;
    const { spanDays, chatCount } = statsOf(cluster.active);
    if (cluster.active.length >= PATTERN_MIN_SAMPLES && chatCount >= PATTERN_MIN_CHATS && spanDays >= PATTERN_MIN_SPAN_DAYS) {
      findings.push(
        finding({
          type: 'PATTERN',
          topicTokens: cluster.core,
          supportMemoryIds: cluster.active.map((memory) => memory.id),
          counterMemoryIds: cluster.inactive.map((memory) => memory.id),
          supportDecisionIds: [],
          sampleCount: cluster.active.length,
          observationSpanDays: spanDays,
          timeFrom: cluster.active[0]!.recordedAt,
          timeTo: statsOf(cluster.active).lastRecordedAt,
          timePrecision: 'TIMESTAMP',
          hypothesisKeys: [...PATTERN_HYPOTHESES]
        })
      );
      continue;
    }
    const reason: InsufficientReason =
      cluster.active.length < PATTERN_MIN_SAMPLES
        ? 'BELOW_SAMPLE_MIN'
        : chatCount < PATTERN_MIN_CHATS
          ? 'BELOW_CHAT_MIN'
          : 'BELOW_SPAN_MIN';
    insufficient.push({
      type: 'PATTERN',
      sampleCount: cluster.active.length,
      observationSpanDays: spanDays,
      reason
    });
  }
  return { findings, insufficient };
}

/** 6.1 CONTRADICTION：两句都还有效，一句肯定一句否定。改口走的是演化边，不会落到这里。 */
function contradictionFindings(clusters: readonly Cluster[]): ReflectionFinding[] {
  const findings: ReflectionFinding[] = [];
  for (const cluster of clusters) {
    if (cluster.active.length < 2) continue;
    let earlier: ReflectableMemory | null = null;
    let later: ReflectableMemory | null = null;
    search: for (let left = 0; left < cluster.active.length; left += 1) {
      for (let right = left + 1; right < cluster.active.length; right += 1) {
        const first = cluster.active[left]!;
        const second = cluster.active[right]!;
        const firstNegative = NEGATION_MARKERS.some((marker) => first.text.includes(marker));
        const secondNegative = NEGATION_MARKERS.some((marker) => second.text.includes(marker));
        if (firstNegative === secondNegative) continue;
        // 同簇是传递相连的，这一对不一定直接重合：要断言「这两句打脸」，得它们自己重合够。
        if (overlap(topicTokens(first.text), topicTokens(second.text)) < TOPIC_MIN_OVERLAP) continue;
        earlier = first;
        later = second;
        break search;
      }
    }
    if (!earlier || !later) continue;
    const support = [earlier, later];
    findings.push(
      finding({
        type: 'CONTRADICTION',
        topicTokens: [...intersect(topicTokens(earlier.text), topicTokens(later.text))].sort(),
        supportMemoryIds: support.map((memory) => memory.id),
        counterMemoryIds: cluster.inactive.map((memory) => memory.id),
        supportDecisionIds: [],
        sampleCount: 2,
        observationSpanDays: daysBetween(later.recordedAt, earlier.recordedAt),
        timeFrom: earlier.recordedAt,
        timeTo: later.recordedAt,
        timePrecision: 'TIMESTAMP',
        hypothesisKeys: []
      })
    );
  }
  return findings;
}

/** 6.1 UNRESOLVED：目标放了很久，而这阵子同主题一句都没有。只报每个簇里最早的那一条。 */
function unresolvedFindings(clusters: readonly Cluster[], now: Date): {
  findings: ReflectionFinding[];
  insufficient: InsufficientEvidence[];
} {
  const findings: ReflectionFinding[] = [];
  const insufficient: InsufficientEvidence[] = [];
  for (const cluster of clusters) {
    const goals = cluster.active.filter((memory) => memory.type === 'GOAL');
    if (goals.length === 0) continue;
    const goal = goals[0]!;
    const ageDays = daysBetween(now, goal.recordedAt);
    if (ageDays < UNRESOLVED_MIN_AGE_DAYS) {
      insufficient.push({
        type: 'UNRESOLVED',
        sampleCount: cluster.active.length,
        observationSpanDays: statsOf(cluster.active).spanDays,
        reason: 'BELOW_AGE_MIN'
      });
      continue;
    }
    const quietSince = new Date(now.getTime() - UNRESOLVED_QUIET_DAYS * DAY_MS);
    const hasRecentTalk = cluster.active.some((memory) => memory.recordedAt > quietSince);
    if (hasRecentTalk) continue;
    // 区间端点：起点跟着那条目标自己的精度走，终点是「现在」这个系统时刻。
    const from = goal.validFrom ?? goal.recordedAt;
    findings.push(
      finding({
        type: 'UNRESOLVED',
        topicTokens: cluster.core,
        supportMemoryIds: [goal.id],
        counterMemoryIds: cluster.inactive.map((memory) => memory.id),
        supportDecisionIds: [],
        sampleCount: cluster.active.length,
        observationSpanDays: daysBetween(now, from),
        timeFrom: from,
        timeTo: now,
        timePrecision: goal.validFrom ? goal.validPrecision : 'TIMESTAMP',
        hypothesisKeys: []
      })
    );
  }
  return { findings, insufficient };
}

/** 演化边两端都要在场。指向池子里没有的记忆的边一律不看：那叫幽灵引用。 */
function edgePair(
  revision: ReflectableRevision,
  byId: Map<string, ReflectableMemory>
): { previous: ReflectableMemory; next: ReflectableMemory } | null {
  if (revision.previousId === null) return null;
  const previous = byId.get(revision.previousId);
  const next = byId.get(revision.memoryId);
  if (!previous || !next) return null;
  return { previous, next };
}

/** 6.1 GOAL_DRIFT：一个目标被另一个目标取代了。两句都留着，旧的进反证列。 */
function goalDriftFindings(
  revisions: readonly ReflectableRevision[],
  byId: Map<string, ReflectableMemory>
): ReflectionFinding[] {
  const findings: ReflectionFinding[] = [];
  for (const revision of revisions) {
    if (revision.action !== 'SUPERSEDED') continue;
    const pair = edgePair(revision, byId);
    if (!pair) continue;
    if (pair.previous.type !== 'GOAL' || pair.next.type !== 'GOAL') continue;
    findings.push(
      finding({
        type: 'GOAL_DRIFT',
        topicTokens: [...intersect(topicTokens(pair.previous.text), topicTokens(pair.next.text))].sort(),
        supportMemoryIds: [pair.next.id],
        counterMemoryIds: [pair.previous.id],
        supportDecisionIds: [],
        sampleCount: 2,
        observationSpanDays: daysBetween(pair.next.recordedAt, pair.previous.recordedAt),
        timeFrom: pair.previous.recordedAt,
        timeTo: pair.next.recordedAt,
        timePrecision: 'TIMESTAMP',
        hypothesisKeys: []
      })
    );
  }
  return findings;
}

/** 6.1 MILESTONE：目标被一句话说「完成了」，或者一条决策被用户确认落定。 */
function milestoneFindings(
  revisions: readonly ReflectableRevision[],
  decisions: readonly ReflectableDecision[],
  byId: Map<string, ReflectableMemory>
): ReflectionFinding[] {
  const findings: ReflectionFinding[] = [];
  for (const revision of revisions) {
    if (revision.action !== 'SUPERSEDED') continue;
    const pair = edgePair(revision, byId);
    if (!pair) continue;
    if (pair.previous.type !== 'GOAL') continue;
    if (!COMPLETION_MARKERS.some((marker) => pair.next.text.includes(marker))) continue;
    findings.push(
      finding({
        type: 'MILESTONE',
        topicTokens: [...intersect(topicTokens(pair.previous.text), topicTokens(pair.next.text))].sort(),
        supportMemoryIds: [pair.previous.id, pair.next.id],
        counterMemoryIds: [],
        supportDecisionIds: [],
        sampleCount: 2,
        observationSpanDays: daysBetween(pair.next.recordedAt, pair.previous.recordedAt),
        timeFrom: pair.previous.recordedAt,
        timeTo: pair.next.recordedAt,
        timePrecision: 'TIMESTAMP',
        hypothesisKeys: []
      })
    );
  }
  for (const decision of [...decisions].sort((left, right) => left.id.localeCompare(right.id))) {
    // 门槛 8：待确认的候选连决策都还不算，不能拿它当里程碑。
    if (decision.status !== 'CONFIRMED') continue;
    const at = decision.confirmedAt;
    if (!at) continue;
    findings.push(
      finding({
        type: 'MILESTONE',
        topicTokens: [...topicTokens(decision.topic)].sort(),
        supportMemoryIds: [],
        counterMemoryIds: [],
        supportDecisionIds: [decision.id],
        sampleCount: 1,
        observationSpanDays: 0,
        timeFrom: at,
        timeTo: at,
        timePrecision: 'TIMESTAMP',
        hypothesisKeys: []
      })
    );
  }
  return findings;
}

/** 6.1 DECISION_LESSON + 5.3：只有用户后来提过结果，才谈得上经验。 */
function decisionLessonFindings(decisions: readonly ReflectableDecision[]): {
  findings: ReflectionFinding[];
  insufficient: InsufficientEvidence[];
} {
  const findings: ReflectionFinding[] = [];
  const insufficient: InsufficientEvidence[] = [];
  for (const decision of [...decisions].sort((left, right) => left.id.localeCompare(right.id))) {
    const tokens = [...topicTokens(decision.topic)].sort();
    if (decision.status === 'OUTCOME_RECORDED' && decision.outcomeRecordedAt && decision.confirmedAt) {
      findings.push(
        finding({
          type: 'DECISION_LESSON',
          topicTokens: tokens,
          supportMemoryIds: [],
          counterMemoryIds: [],
          supportDecisionIds: [decision.id],
          sampleCount: 1,
          observationSpanDays: daysBetween(decision.outcomeRecordedAt, decision.confirmedAt),
          // 区间只用两个系统时刻。decidedAt 是用户话里的时间，决策行上没有精度列，
          // 拿它当精确日期就是门槛 6 不许的那种伪造。
          timeFrom: decision.confirmedAt,
          timeTo: decision.outcomeRecordedAt,
          timePrecision: 'TIMESTAMP',
          hypothesisKeys: []
        })
      );
      continue;
    }
    if (decision.status === 'CONFIRMED' && !decision.outcomeRecordedAt) {
      insufficient.push({
        type: 'DECISION_LESSON',
        sampleCount: 0,
        observationSpanDays: 0,
        reason: 'BELOW_OUTCOME_MIN'
      });
    }
  }
  return { findings, insufficient };
}

/**
 * 6.1 INTEREST_SHIFT：样本最多的旧主题 → 最近的新技术主题。
 * 两个主题都要够样本、中位数要够远，否则就是「这周换了个话题」。
 */
function interestShiftFindings(clusters: readonly Cluster[]): {
  findings: ReflectionFinding[];
  insufficient: InsufficientEvidence[];
} {
  const findings: ReflectionFinding[] = [];
  const insufficient: InsufficientEvidence[] = [];
  const usable = clusters.filter((cluster) => cluster.active.length >= 1);
  if (usable.length < 2) return { findings, insufficient };

  const medianOf = (cluster: Cluster): number => {
    const times = cluster.active.map((memory) => memory.recordedAt.getTime()).sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)] ?? 0;
  };
  const ordered = [...usable].sort((left, right) => medianOf(right) - medianOf(left));
  const newer = ordered[0]!;
  const newerMedian = medianOf(newer);
  if (newer.active.length < INTEREST_SHIFT_MIN_SAMPLES) {
    insufficient.push({
      type: 'INTEREST_SHIFT',
      sampleCount: newer.active.length,
      observationSpanDays: statsOf(newer.active).spanDays,
      reason: 'BELOW_SAMPLE_MIN'
    });
    return { findings, insufficient };
  }

  const candidates = ordered
    .slice(1)
    .filter((cluster) => newerMedian - medianOf(cluster) >= INTEREST_SHIFT_MEDIAN_GAP_DAYS * DAY_MS);
  if (candidates.length === 0) {
    insufficient.push({
      type: 'INTEREST_SHIFT',
      sampleCount: newer.active.length,
      observationSpanDays: statsOf(newer.active).spanDays,
      reason: 'BELOW_MEDIAN_GAP'
    });
    return { findings, insufficient };
  }
  const older = [...candidates].sort(
    (left, right) => right.active.length - left.active.length || medianOf(left) - medianOf(right)
  )[0]!;
  if (older.active.length < INTEREST_SHIFT_MIN_SAMPLES) {
    insufficient.push({
      type: 'INTEREST_SHIFT',
      sampleCount: older.active.length,
      observationSpanDays: statsOf(older.active).spanDays,
      reason: 'BELOW_SAMPLE_MIN'
    });
    return { findings, insufficient };
  }

  const times = [...newer.active, ...older.active].map((memory) => memory.recordedAt);
  findings.push(
    finding({
      type: 'INTEREST_SHIFT',
      topicTokens: [...new Set([...older.core, ...newer.core])].sort(),
      supportMemoryIds: newer.active.map((memory) => memory.id),
      counterMemoryIds: older.active.map((memory) => memory.id),
      supportDecisionIds: [],
      sampleCount: newer.active.length + older.active.length,
      observationSpanDays: daysBetween(new Date(Math.max(...times.map((t) => t.getTime()))), new Date(Math.min(...times.map((t) => t.getTime())))),
      timeFrom: new Date(Math.min(...times.map((t) => t.getTime()))),
      timeTo: new Date(Math.max(...times.map((t) => t.getTime()))),
      timePrecision: 'TIMESTAMP',
      hypothesisKeys: []
    })
  );
  return { findings, insufficient };
}

function orderedByType<T extends { type: string; dedupKey?: string }>(list: T[]): T[] {
  return list.sort((left, right) => {
    const byType = left.type.localeCompare(right.type);
    if (byType !== 0) return byType;
    const leftKey = left.dedupKey ?? '';
    const rightKey = right.dedupKey ?? '';
    return leftKey.localeCompare(rightKey);
  });
}

export function planReflections(input: ReflectionPlanInput): ReflectionPlan {
  const memories = input.memories;
  const revisions = input.revisions ?? [];
  const decisions = input.decisions ?? [];
  // 两类素材各自能独立成洞察（记忆靠聚类，决策行本身就是一条事实），所以「池子空」
  // 必须是两边都空——只有决策没有记忆时，MILESTONE/DECISION_LESSON 照样有依据。
  if (memories.length === 0 && decisions.length === 0) return { findings: [], insufficient: [] };

  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const clusters = buildClusters(memories);

  const pattern = patternFindings(clusters);
  const unresolved = unresolvedFindings(clusters, input.now);
  const shift = interestShiftFindings(clusters);
  const lesson = decisionLessonFindings(decisions);

  const findings = orderedByType([
    ...pattern.findings,
    ...contradictionFindings(clusters),
    ...unresolved.findings,
    ...goalDriftFindings(revisions, byId),
    ...milestoneFindings(revisions, decisions, byId),
    ...lesson.findings,
    ...shift.findings
  ]);
  const insufficient = orderedByType([
    ...pattern.insufficient,
    ...unresolved.insufficient,
    ...shift.insufficient,
    ...lesson.insufficient
  ]);
  return { findings, insufficient };
}
