import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { decryptString, encryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { decryptDecisionTopic } from './decisions';
import { decryptMemoryContent } from './memories';
import { getCognitivePreferences } from './preferences';
import { fromDbMemoryContext, getMemoryPolicies, type MemoryContext, type MemoryPolicy } from './policy';
import {
  CONF_SAMPLES_FULL,
  CONF_SPAN_FULL_DAYS,
  criticizeReflection,
  findCounterEvidence,
  HYPOTHESIS_PHRASES,
  phraseReflection,
  reflectionConfidence,
  supportTextsOf
} from './reflection-evidence';
import {
  planReflections,
  REFLECTION_POOL_LIMIT,
  sharesTopicWith,
  type PatternHypothesis,
  type ReflectableDecision,
  type ReflectableMemory,
  type ReflectableRevision,
  type ReflectionFinding
} from './reflection-planner';

/**
 * 反思生成落库（任务书 6.5 的落库、6.6 的冷却与限量、1.2 的逐情境闸门）。
 *
 * 6-B 出题、6-C 措辞，两片都是纯函数；这一片是它们第一次往库里写东西，所以它只管纯函数管不了的
 * 三件事：**什么时候允许跑、这个用户这一轮最多收几条、以及写下去的每一行对不对得上它读过的那几行**。
 *
 * 四条形状上的约定，都是有理由才长成这样的：
 * 一、它不是 CognitiveModule。模块写侧吃的是「这一轮对话」，扫描吃的是「这个用户的整个记忆池」，
 *    硬塞进模块接口就得伪造一个 turn，而伪造的 turn 会让 manager 那道「开关关 ⇒ 欠账作废」的闸门
 *    判错东西。所以这里直接读偏好，`reflectionEnabled` 是唯一的模块级开关。
 * 二、正文一次都不进日志。insufficient 带类型和两个计数，critic 带原因码，闸门带情境名和
 *    dedupKey（sha1 前 16 位）——测试把这条钉成「日志里不许出现一个汉字」。
 * 三、时间全部从外面传进来（now），连 generatedAt 和 expiresAt 都用它：让后台去读系统时钟，
 *    同一次扫描的两次重跑就会给出两个失效期，而门槛 6 说的正是时间不许含糊。
 * 四、反证只影响口气，不影响它值不值得占那一屏的三个位置：`confidence` 扣反证，
 *    `importance` 是不扣的那一份证据量。两个数各说各的事，界面才不会把「有争议」读成「没证据」。
 *
 * 五、这一版起，扫描还是 `ReflectionStatus` 里两个状态的唯一生产者（门槛 7）：
 *    抢到冷却后的第一件事把 `PENDING` 且已过 `expiresAt` 的行置 `EXPIRED`，把 `SNOOZED` 且
 *    已到期（`snoozedUntil <= now`）的行放回 `PENDING` 并清空 `snoozedUntil`——没有这一句，
 *    TTL 只是库里的一个日期，而 SNOOZED 是个只进不出的死状态。收割走在读池子之前：
 *    到期处理和聚类没有依赖关系，池子读挂了也该把它做掉。
 *    同一个循环里还开了 REJECTED 的口子：被拒的主题只在「决定之后新记过同话题的一句」时
 *    写回**同一行**（密文 AAD 绑的就是那一行的 id），见 hasNewEvidence。
 *
 * 冷却用条件 UPDATE 抢，和 task-queue.ts 领任务行是同一个协议：`reflectionSweptAt IS NULL
 * OR < cutoff` 那一半不能省——SQL 里 NULL 不参与比较，漏掉它第一次扫描永远排不上。
 * 先抢后跑：跑挂了也要等满冷却才重来，换掉的是「一次数据库抖动让每两秒重算一遍 O(n²) 聚类」。
 *
 * 测试：tests/unit/cognitive-reflection-sweep.test.ts
 */

/** 冷却。一天一次是任务书 6.6 给的节奏，也是成簇那 O(n²) 一天能承受的次数上限。 */
export const REFLECTION_SWEEP_COOLDOWN_HOURS = 24;
/** 一轮最多落三条：一屏放得下，而且「攒着一次倒五十条」不是提醒，是轰炸。 */
export const MAX_NEW_PER_SWEEP = 3;
/** 没人理的洞察活 30 天。这一列配上 sweepBody 的收割才让 EXPIRED 有个生产者（门槛 7）；读侧也按它提前判。 */
export const REFLECTION_TTL_DAYS = 30;
/**
 * 硬截止。扫描和写任务共用同一条串行的 worker 轮次，不限死它，一个用户的记忆池就能把别人排着的
 * 欠账一起拖住。必须小于 COGNITIVE_TASK_LEASE_MS，否则行还在跑就已经被别人领走了。
 */
export const REFLECTION_SWEEP_DEADLINE_MS = 15_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const aadFor = (userId: string, id: string, field: string) => `reflection:v1:${userId}:${id}:${field}`;

/**
 * 决策证据的情境。DecisionRecord 上没有 context 列，而一行决策只能由 decisionMaking 那一档
 * （`requireConfirmation: true` 的那条链路）产生，所以按这一档过闸——不是「没有情境就放行」。
 */
const DECISION_CONTEXT: MemoryContext = 'decisionMaking';

export interface SweepOutcome {
  /** 抢到冷却并真的开跑了。false 只可能是开关关着或冷却没到，两种都不该有任何写入。 */
  ran: boolean;
  generated: number;
  /** 被逐情境策略挡下的条数。 */
  gateBlocked: number;
  /** critic 拒掉的条数。甲方案下正常数据到不了这里，它是最后一道防线，不是常规路径。 */
  criticRejected: number;
  /** 这个主题已经存在了：应用层预筛和库层唯一约束两种命中都记在这里。 */
  dedupSkipped: number;
  insufficient: number;
  /** 这一轮收割掉的过期洞察（PENDING 且 expiresAt 已过 → EXPIRED）。门槛 7 里 EXPIRED 的生产者。 */
  expired: number;
  /** 这一轮醒过来的稍后洞察（SNOOZED 且 snoozedUntil 已过 → 回到 PENDING）。 */
  reactivated: number;
  /** 这一轮因新证据而复活的被拒洞察：写回**同一行**，不新增。 */
  revived: number;
  /** 撞上 REFLECTION_SWEEP_DEADLINE_MS：这一轮没跑完，已经算出来的计数还在。 */
  timedOut: boolean;
  /** 这一轮被一次真实的失败中断：偏好读不出、抢戳失败、收割报错、解密炸、写库报错。超时另记在 timedOut。 */
  failed: boolean;
}

const NOTHING_DONE: SweepOutcome = {
  ran: false,
  generated: 0,
  gateBlocked: 0,
  criticRejected: 0,
  dedupSkipped: 0,
  insufficient: 0,
  expired: 0,
  reactivated: 0,
  revived: 0,
  timedOut: false,
  failed: false
};

/** 一条过了所有关卡、等着占那一屏三个位置之一的洞察。 */
interface Prepared {
  finding: ReflectionFinding;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  /** 计划层的反证 + 这一轮现搜的反证，去重之后就是落库的 CONTRADICTS 引用行。 */
  counterIds: string[];
  /**
   * 有它就不是新写一条，而是把用户拒过的那一行**复活**：同一行 id 写回新正文。
   * 必须同一行有两个理由——密文的 AAD 绑的就是那个 id，而且 `@@unique([userId, dedupKey])`
   * 本来也不允许同一个主题存在两行。
   */
  reviveRowId?: string;
}

export async function runReflectionSweep(userId: string, input: { now: Date }): Promise<SweepOutcome> {
  const now = input.now;

  // 开关关着的用户不该被盖上时间戳：他 later 打开开关时，不该为一次根本没跑过的扫描再等一天。
  let reflectionEnabled: boolean;
  let memoryEnabled: boolean;
  try {
    const preferences = await getCognitivePreferences(userId);
    reflectionEnabled = preferences.reflectionEnabled === true;
    memoryEnabled = preferences.memoryEnabled === true;
  } catch {
    log.warn('cognitive.reflection_sweep_failed', { userId, reason: 'preferences_unavailable' });
    return { ...NOTHING_DONE, failed: true };
  }
  if (!reflectionEnabled) return NOTHING_DONE;

  let claimed: number;
  try {
    const result = await prisma.cognitivePreference.updateMany({
      where: {
        userId,
        OR: [
          { reflectionSweptAt: null },
          { reflectionSweptAt: { lt: new Date(now.getTime() - REFLECTION_SWEEP_COOLDOWN_HOURS * HOUR_MS) } }
        ]
      },
      data: { reflectionSweptAt: now }
    });
    claimed = result.count;
  } catch {
    log.warn('cognitive.reflection_sweep_failed', { userId, reason: 'claim_failed' });
    return { ...NOTHING_DONE, failed: true };
  }
  if (claimed === 0) return NOTHING_DONE;

  const outcome: SweepOutcome = { ...NOTHING_DONE, ran: true };
  const settled = await runWithinDeadline(sweepBody(userId, now, outcome, memoryEnabled), REFLECTION_SWEEP_DEADLINE_MS);
  outcome.timedOut = settled === 'timeout';
  outcome.failed = settled === 'failed';
  if (outcome.timedOut) log.warn('cognitive.reflection_sweep_timeout', { userId });

  log.debug('cognitive.reflection_sweep', {
    userId,
    generated: outcome.generated,
    gateBlocked: outcome.gateBlocked,
    criticRejected: outcome.criticRejected,
    dedupSkipped: outcome.dedupSkipped,
    insufficient: outcome.insufficient,
    expired: outcome.expired,
    reactivated: outcome.reactivated,
    revived: outcome.revived,
    timedOut: outcome.timedOut,
    failed: outcome.failed
  });
  return outcome;
}

/**
 * 跑这一轮，把计数写在 `outcome` 上（超时中止时那些已经算出来的计数才留得下来）。
 * 返回值是「有没有被一次真实失败打断」，超时由调用方判断。
 */
async function sweepBody(
  userId: string,
  now: Date,
  outcome: SweepOutcome,
  memoryEnabled: boolean
): Promise<boolean> {
  // 收割排在读池子之前：门槛 7 要求 EXPIRED 有人写、SNOOZED 不是个只进不出的死状态，
  // 而这两件事和「这个用户这一轮能不能扫出新洞察」没有依赖关系——池子读挂了也该把到期处理掉。
  // 条件 UPDATE 的形状和抢戳、领任务行是同一个协议：只碰自己用户的行，且带着状态条件。
  try {
    outcome.expired = (
      await prisma.reflectionRecord.updateMany({
        where: { userId, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' }
      })
    ).count;
    outcome.reactivated = (
      await prisma.reflectionRecord.updateMany({
        where: { userId, status: 'SNOOZED', snoozedUntil: { lte: now } },
        data: { status: 'PENDING', snoozedUntil: null }
      })
    ).count;
  } catch {
    log.warn('cognitive.reflection_sweep_failed', { userId, reason: 'reap_failed' });
    return true;
  }

  // 洞察的证据就是记忆原文，所以 `memoryEnabled` 关着时这一轮一行都不该读（任务书 1.1：
  // 关闭模块后不能继续执行对应的数据读取、生成和后台写入）。
  //
  // 位置是挑过的：闸门落在收割**之后**、读池子之前。落在最前面会把 SNOOZED 变成只进不出的死状态
  // ——用户关着长期记忆的期间点的「稍后」到期后没人把它放回 PENDING。代价写在这里：
  // 这一轮仍然抢了冷却戳，所以他后来打开长期记忆时，最坏要再等一天才扫出新洞察；
  // 「收割照跑」比「打开开关立刻能扫」更值得要，因为前者是状态机的正确性，后者只是等待。
  if (!memoryEnabled) return false;

  let pool: {
    memories: ReflectableMemory[];
    contextByMemoryId: Map<string, MemoryContext>;
    revisions: ReflectableRevision[];
    decisions: ReflectableDecision[];
    textByMemoryId: Map<string, string>;
    topicByDecisionId: Map<string, string>;
  };
  try {
    pool = await loadPool(userId);
  } catch {
    log.warn('cognitive.reflection_sweep_failed', { userId, reason: 'pool_unavailable' });
    return true;
  }

  const plan = planReflections({
    now,
    memories: pool.memories,
    revisions: pool.revisions,
    decisions: pool.decisions
  });
  for (const gap of plan.insufficient) {
    outcome.insufficient += 1;
    log.debug('cognitive.reflection_insufficient', {
      userId,
      type: gap.type,
      sampleCount: gap.sampleCount,
      observationSpanDays: gap.observationSpanDays,
      reason: gap.reason
    });
  }
  if (plan.findings.length === 0) return false;

  const policies = await getMemoryPolicies(userId);
  const existing = await existingReflections(
    userId,
    plan.findings.map((finding) => finding.dedupKey)
  );
  // critic 要的那份「这次扫描真正读到的行」：记忆和决策都算，漏掉决策就会把
  // 每一条 DECISION_LESSON 都判成幽灵引用。
  const poolIds = [...pool.memories.map((memory) => memory.id), ...pool.decisions.map((decision) => decision.id)];

  const prepared: Prepared[] = [];
  for (const finding of plan.findings) {
    const prior = existing.get(finding.dedupKey);
    // 6.6 的去重：这个主题已经跟用户说过一次了。唯一的例外是「被拒过而且有了新证据」——
    // 否则按下忽略就等于永久消音，而那不是 6.4 里 REJECTED 这个状态的意思。
    if (
      prior !== undefined &&
      !(prior.status === 'REJECTED' && hasNewEvidence(prior.decidedAt, finding, pool))
    ) {
      outcome.dedupSkipped += 1;
      log.debug('cognitive.reflection_dedup_skipped', { userId, type: finding.type, dedupKey: finding.dedupKey });
      continue;
    }
    const blocked = blockedContext(finding, pool.contextByMemoryId, policies);
    if (blocked !== null) {
      outcome.gateBlocked += 1;
      log.debug('cognitive.reflection_gate_blocked', {
        userId,
        type: finding.type,
        dedupKey: finding.dedupKey,
        context: blocked
      });
      continue;
    }

    const counterIds = [
      ...new Set([...finding.counterMemoryIds, ...findCounterEvidence(finding, pool.memories)])
    ];
    const { score, band } = reflectionConfidence({
      sampleCount: finding.sampleCount,
      observationSpanDays: finding.observationSpanDays,
      counterHits: counterIds.length
    });
    const draft = phraseReflection({
      finding,
      band,
      memoryTexts: pool.textByMemoryId,
      decisionTopics: pool.topicByDecisionId,
      counterHits: counterIds.length
    });
    const supportTexts = supportTextsOf(finding, pool.textByMemoryId, pool.topicByDecisionId);
    const verdict = criticizeReflection({ finding, draft, counterHits: counterIds.length, poolIds, supportTexts });
    if (!verdict.accepted) {
      outcome.criticRejected += 1;
      log.warn('cognitive.reflection_critic_rejected', {
        userId,
        type: finding.type,
        dedupKey: finding.dedupKey,
        reasons: verdict.reasons
      });
      continue;
    }

    prepared.push({
      finding,
      title: draft.title,
      body: draft.body,
      confidence: score,
      importance: importanceOf(finding),
      counterIds,
      // 走到这里还能带着 prior，就只有「被拒过 + 有新证据」这一种情况：写回那一行。
      ...(prior ? { reviveRowId: prior.id } : {})
    });
  }

  // 同一条池子每次扫都排出同一批：先按证据量，同分再按主题键，谁也不靠运气占位置。
  const ranked = prepared.sort(
    (left, right) =>
      right.importance - left.importance || left.finding.dedupKey.localeCompare(right.finding.dedupKey)
  );

  for (const item of ranked.slice(0, MAX_NEW_PER_SWEEP)) {
    try {
      await writeReflection(userId, now, item);
      // 复活和新写都占那一屏的三个位置：分开的只是计数器，不是额度。
      if (item.reviveRowId) outcome.revived += 1;
      else outcome.generated += 1;
    } catch (err) {
      if (isDuplicateKey(err)) {
        // 并发里抢先后到：库层那条 @@unique([userId, dedupKey]) 才是 6.6 的最终出处。
        outcome.dedupSkipped += 1;
        log.debug('cognitive.reflection_dedup_skipped', {
          userId,
          type: item.finding.type,
          dedupKey: item.finding.dedupKey
        });
        continue;
      }
      log.warn('cognitive.reflection_sweep_failed', { userId, reason: 'write_failed' });
      return true;
    }
  }
  return false;
}

interface PoolRow {
  context: MemoryContext;
  memory: ReflectableMemory;
}

async function loadPool(userId: string) {
  // 最新的 500 条——planner 那个 O(n²) 上限在这里兑现。倒着取再翻回来，池子就是时间正序。
  // 归档的行不进池子（任务书 7.2）：这一片不读 listMemories，得自己带上同一口径，
  // 否则用户把记忆收起来了，洞察还在正文里复述它。
  const memoryRows = await prisma.memoryItem.findMany({
    where: { userId, archivedAt: null },
    orderBy: { recordedAt: 'desc' },
    take: REFLECTION_POOL_LIMIT
  });
  const parsed: PoolRow[] = memoryRows.map((row) => {
    // 一行只解一次密：500 行的池子里每行多做一次 GCM，就是把扫描的固定成本翻了一倍。
    const text = decryptMemoryContent(row, userId);
    return {
      context: fromDbMemoryContext(row.context),
      memory: {
        id: row.id,
        text,
        type: row.type,
        origin: row.origin,
        chatId: row.chatId,
        recordedAt: row.recordedAt,
        validFrom: row.validFrom,
        validPrecision: row.validPrecision,
        supersededAt: row.supersededAt
      }
    };
  });
  parsed.reverse();

  const revisionRows = await prisma.memoryRevision.findMany({ where: { userId } });
  const decisionRows = await prisma.decisionRecord.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: REFLECTION_POOL_LIMIT
  });
  // 只算用户点过头的那一份（LINKED）：CANDIDATE 是系统猜的归因，DETACHED 是用户收回的归因，
  // 两者都不算「这个人真的报过结果」。拿它们撑 DECISION_LESSON，就是推断凌驾于真实表达。
  const outcomeRows = await prisma.decisionOutcome.findMany({
    where: { userId, linkStatus: 'LINKED' }
  });

  const earliestOutcome = new Map<string, Date>();
  for (const row of outcomeRows) {
    const current = earliestOutcome.get(row.decisionId);
    if (current === undefined || row.recordedAt < current) earliestOutcome.set(row.decisionId, row.recordedAt);
  }

  const decisions: ReflectableDecision[] = decisionRows.map((row) => ({
    id: row.id,
    status: row.status,
    topic: decryptDecisionTopic(row, userId),
    confirmedAt: row.confirmedAt,
    outcomeRecordedAt: earliestOutcome.get(row.id) ?? null
  }));
  decisions.reverse();

  return {
    memories: parsed.map((row) => row.memory),
    contextByMemoryId: new Map(parsed.map((row) => [row.memory.id, row.context])),
    textByMemoryId: new Map(parsed.map((row) => [row.memory.id, row.memory.text])),
    revisions: revisionRows.map((row) => ({
      action: row.action,
      memoryId: row.memoryId,
      previousId: row.previousId,
      createdAt: row.createdAt
    })),
    decisions,
    topicByDecisionId: new Map(decisions.map((decision) => [decision.id, decision.topic]))
  };
}

/** 这一条洞察引用的每个情境都放开，它才许落地；返回挡住它的那个情境。 */
function blockedContext(
  finding: ReflectionFinding,
  contextByMemoryId: ReadonlyMap<string, MemoryContext>,
  policies: Readonly<Record<MemoryContext, MemoryPolicy>>
): MemoryContext | 'unknown' | null {
  for (const id of [...finding.supportMemoryIds, ...finding.counterMemoryIds]) {
    const context = contextByMemoryId.get(id);
    // 引用不在读过的池子里 = 说不出它属于哪个情境，闸门先挡住（critic 那条路也就不用走了）。
    if (context === undefined) return 'unknown';
    if (policies[context].allowReflection !== true) return context;
  }
  if (finding.supportDecisionIds.length > 0 && policies[DECISION_CONTEXT].allowReflection !== true) {
    return DECISION_CONTEXT;
  }
  return null;
}

/**
 * 证据量：样本和跨度各占一半，封顶同 6-C 的置信度用同一组常量。
 * 和 `confidence` 的差别只有一处——不扣反证，理由写在文件头第四条。
 */
function importanceOf(finding: ReflectionFinding): number {
  const samples = Math.min(1, Math.max(0, finding.sampleCount) / CONF_SAMPLES_FULL);
  const span = Math.min(1, Math.max(0, finding.observationSpanDays) / CONF_SPAN_FULL_DAYS);
  return Math.round(((samples + span) / 2) * 1000) / 1000;
}

/**
 * 这些主题库里已经有行了吗。除了「有没有」还要带回状态和决定时间，因为 6.6 的去重对
 * 被拒的主题留了一个口子（见 hasNewEvidence）。库层唯一约束兜并发，这一句只是别让它们白排一趟。
 */
async function existingReflections(
  userId: string,
  dedupKeys: readonly string[]
): Promise<Map<string, { id: string; status: string; decidedAt: Date | null }>> {
  if (dedupKeys.length === 0) return new Map();
  const rows = await prisma.reflectionRecord.findMany({
    where: { userId, dedupKey: { in: [...dedupKeys] } },
    select: { id: true, dedupKey: true, status: true, decidedAt: true }
  });
  return new Map(rows.map((row) => [row.dedupKey, { id: row.id, status: row.status, decidedAt: row.decidedAt }]));
}

/**
 * 被拒的洞察什么时候允许再来一次：拒绝之后又记进来了**同一话题**的一句。
 *
 * 「同一话题」用的是成簇那把尺子（planner 导出的 `sharesTopicWith`），不是这里的第二套标准——
 * 一个词表两处解释迟早漂移。两个刻意的窄口径：
 * 一、看的是这个用户新记下的行，不是这条洞察的 supportMemoryIds。实测过才发现后者不能用：
 *    CONTRADICTION 那一类的支持证据固定是相抵的那两句的代表，第三句同类的话根本不会进去，
 *    照 supportMemoryIds 判「有没有新证据」会永远判出「没有」，被拒的主题就再也醒不过来。
 * 二、`decidedAt` 为空就不放行：这一版之前的老行说不出决定时间，「在这之后有新证据」证不出来，
 *    那条主题就继续沉默；每天拿同一句话去骚扰用户，比少说一次更糟。
 */
function hasNewEvidence(
  decidedAt: Date | null,
  finding: ReflectionFinding,
  pool: { memories: readonly ReflectableMemory[]; textByMemoryId: ReadonlyMap<string, string> }
): boolean {
  if (decidedAt === null) return false;
  return pool.memories.some((memory) => {
    if (memory.recordedAt.getTime() <= decidedAt.getTime()) return false;
    const text = pool.textByMemoryId.get(memory.id);
    return text !== undefined && sharesTopicWith(text, finding.topicTokens);
  });
}

async function writeReflection(userId: string, now: Date, item: Prepared): Promise<void> {
  const { finding } = item;
  // id 先在应用层出来：字段 AAD 绑的就是它，等库生成就来不及了。
  // 复活的场合直接沿用被拒那一行的 id——换了 id，那三段老密文就再也解不开。
  const id = item.reviveRowId ?? randomUUID();
  const aad = (field: string) => aadFor(userId, id, field);
  const alternatives = finding.hypothesisKeys
    .map((key) => HYPOTHESIS_PHRASES[key as PatternHypothesis])
    .filter((phrase): phrase is string => typeof phrase === 'string')
    .join('；');

  const supports = [
    ...finding.supportMemoryIds.map((memoryId) => ({ memoryId, decisionId: null as string | null })),
    ...finding.supportDecisionIds.map((decisionId) => ({ memoryId: null as string | null, decisionId }))
  ];
  const contradicts = item.counterIds.map((memoryId) => ({ memoryId, decisionId: null as string | null }));

  const columns = {
    type: finding.type,
    dedupKey: finding.dedupKey,
    titleCiphertext: encryptString(item.title, aad('title')),
    bodyCiphertext: encryptString(item.body, aad('body')),
    alternativesCiphertext: alternatives === '' ? null : encryptString(alternatives, aad('alternatives')),
    counterTokensCiphertext: encryptString(finding.topicTokens.join(' '), aad('counterTokens')),
    counterHitCount: item.counterIds.length,
    timeFrom: finding.timeFrom,
    timeTo: finding.timeTo,
    timePrecision: finding.timePrecision,
    sampleCount: finding.sampleCount,
    observationSpanDays: finding.observationSpanDays,
    confidence: item.confidence,
    importance: item.importance,
    generatedAt: now,
    expiresAt: new Date(now.getTime() + REFLECTION_TTL_DAYS * DAY_MS)
  };

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (item.reviveRowId) {
      // where 带着 userId：这条 UPDATE 只能碰这个用户自己的那一行。
      await tx.reflectionRecord.updateMany({
        where: { id, userId },
        data: { ...columns, status: 'PENDING', decidedAt: null, snoozedUntil: null }
      });
      // 老引用整批换掉：留着上一次的证据，等于让界面说出一个现在支撑不了的理由。
      await tx.reflectionCitation.deleteMany({ where: { reflectionId: id, userId } });
    } else {
      await tx.reflectionRecord.create({ data: { id, userId, status: 'PENDING', ...columns } });
    }
    // 引用行必须跟洞察行同事务：门槛 4 要的是「这条洞察引用的那几行当时就在」，
    // 半截状态（有洞察没引用）比一条都不写更难解释。
    for (const citation of [
      ...supports.map((row) => ({ ...row, kind: 'SUPPORTS' as const })),
      ...contradicts.map((row) => ({ ...row, kind: 'CONTRADICTS' as const }))
    ]) {
      await tx.reflectionCitation.create({
        data: {
          userId,
          reflectionId: id,
          memoryId: citation.memoryId,
          decisionId: citation.decisionId,
          kind: citation.kind
        }
      });
    }
  });

  log.debug('cognitive.reflection_written', {
    userId,
    reflectionId: id,
    type: finding.type,
    dedupKey: finding.dedupKey,
    citationCount: supports.length + contradicts.length
  });
}

/**
 * 到点了就先收：已经算出来的计数留在 `outcome` 上，没写完的那一条不写。
 * 扫描永不因为超时回滚——每条洞察自己是一个事务，中断只会少写几条，不会写出半条。
 *
 * 三态而不是布尔：超时是「没跑完」，`sweepBody` 报的失败是「跑出了问题」。两个数在日志里
 * 各说各的事，混成一个就没法回答「这个用户的池子是不是慢到扫不动」。
 */
async function runWithinDeadline(
  task: Promise<boolean>,
  deadlineMs: number
): Promise<'ok' | 'failed' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
  });
  // sweepBody 自己把失败收成 true，这一层只防「连 catch 里都抛」那种漏网的：
  // 它一旦逃出去，worker 那一轮就没人 await 了。
  const settled = task.then(
    (failed): 'ok' | 'failed' => (failed ? 'failed' : 'ok'),
    (): 'failed' => 'failed'
  );
  const raced = await Promise.race([settled, alarm]);
  clearTimeout(timer);
  if (raced === 'timeout') {
    task.catch(() => undefined);
    return 'timeout';
  }
  return raced;
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: string }).code === 'P2002';
}
