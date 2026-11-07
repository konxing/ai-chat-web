import type { MemoryDto, MemoryOrigin, MemoryRevisionAction, TimePrecision } from './memories';
import type { MemoryContext, MemoryRetention, MemoryType } from './policy';
import type { ConfidenceBand, ConfidenceFactor } from './confidence';
import type { ReconsolidationFlag } from './reconsolidation';
import type { FailedTaskReason } from './failed-tasks';

/**
 * 记忆的前端展示词汇：枚举的中文标签 + 有效区间回显。
 *
 * 这个文件只许有纯函数和常量。上游的 memories.ts / policy.ts 都 import 了 prisma，
 * 客户端组件直接引用那几个标签会把数据库驱动拖进浏览器包，所以标签搬到这里，
 * 类型用 `import type` 引（编译期抹掉，不产生运行时依赖）。
 * 边界由 tests/unit/memory-display.test.ts 钉住。
 */

export const TYPE_LABELS: Record<MemoryType, string> = {
  fact: '事实',
  preference: '偏好',
  goal: '目标',
  project: '项目',
  decision: '决策',
  emotion: '情绪'
};

/**
 * 五类记忆体系（混合式记忆升级 Phase 1，借鉴 LangMem / Letta 的分层思想）。
 *
 * 这是现有六个 `MemoryType` 之上的一层**功能分类**，不是新存储：同一条记忆仍只存一行，
 * 「类」回答的是「这条记忆在认知里扮演什么角色」，供召回路由、巩固和界面分组使用。
 *
 * - working（工作记忆）：当前会话上下文，由现有上下文窗口承载，**不长期落库**，所以没有
 *   对应的存储 type，也不参与下面的 classifyMemoryClass（它只分类已落库的长期记忆）。
 * - episodic（情景）：具体经历/事件——项目、决策、情绪感受。
 * - semantic（语义）：稳定事实与长期认知——事实、长期目标。
 * - procedural（程序）：偏好与协作方式。
 * - prospective（前瞻）：未来计划/意图。目标里带明确未来说法的归这一类，否则归语义（长期目标）。
 *
 * 分类只由 type 和原文里的未来标记决定，不调模型、不猜：一次偶然讨论不会被升成长期专长。
 */
export const MEMORY_CLASSES = ['working', 'episodic', 'semantic', 'procedural', 'prospective'] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];
/** 已落库的长期记忆只可能是后四类；working 是会话层，不入库。 */
export type StoredMemoryClass = Exclude<MemoryClass, 'working'>;

export const MEMORY_CLASS_LABELS: Record<MemoryClass, string> = {
  working: '工作记忆',
  episodic: '情景记忆',
  semantic: '语义记忆',
  procedural: '程序性记忆',
  prospective: '前瞻记忆'
};

export const MEMORY_CLASS_ORDER: readonly MemoryClass[] = [
  'working',
  'episodic',
  'semantic',
  'procedural',
  'prospective'
];

/** 目标句里出现这些说法，才算「未来计划」（前瞻），否则按长期目标（语义）处理。 */
const PROSPECTIVE_MARKERS: readonly string[] = [
  '打算',
  '计划',
  '准备',
  '未来',
  '明年',
  '下个月',
  '以后要',
  '接下来'
];

export function classifyMemoryClass(type: MemoryType, content: string): StoredMemoryClass {
  if (type === 'project' || type === 'decision' || type === 'emotion') return 'episodic';
  if (type === 'preference') return 'procedural';
  if (type === 'goal') {
    return PROSPECTIVE_MARKERS.some((marker) => content.includes(marker)) ? 'prospective' : 'semantic';
  }
  return 'semantic';
}

/** 界面 chip 用：一条已落库记忆的功能分类标签。 */
export function memoryClassLabel(memory: Pick<MemoryDto, 'type' | 'content'>): string {
  return MEMORY_CLASS_LABELS[classifyMemoryClass(memory.type, memory.content)];
}

export const CONTEXT_LABELS: Record<MemoryContext, string> = {
  general: '日常',
  technicalProject: '技术项目',
  learning: '学习',
  personalGoal: '个人目标',
  personalReflection: '自我反思',
  emotionalSupport: '情绪支持',
  decisionMaking: '决策'
};

/** 「推断」「假设」永远不许写成「亲口说」「已确认」——来源是这条记忆能不能信的关键。 */
export const ORIGIN_LABELS: Record<MemoryOrigin, string> = {
  explicit: '亲口说',
  userConfirmed: '已确认',
  observed: '观察到',
  inferred: '推断',
  hypothesis: '假设',
  retracted: '已撤回'
};

export const REVISION_ACTION_LABELS: Record<MemoryRevisionAction, string> = {
  superseded: '更新为新说法',
  retracted: '撤回'
};

export const RETENTION_LABELS: Record<MemoryRetention, string> = {
  forever: '长期保留',
  untilSuperseded: '直到有新说法',
  days90: '90 天',
  days30: '30 天',
  sessionOnly: '只在当次对话'
};

/**
 * 渲染顺序。policy.ts 里也有同一份顺序，但那个文件 import 了 prisma，
 * 客户端组件不能运行时引用，所以这里各写一份，漂移由 cognitive-memory-policy.test.ts 钉住。
 */
export const CONTEXT_ORDER: readonly MemoryContext[] = [
  'general',
  'technicalProject',
  'learning',
  'personalGoal',
  'personalReflection',
  'emotionalSupport',
  'decisionMaking'
];

export const TYPE_ORDER: readonly MemoryType[] = ['fact', 'preference', 'goal', 'project', 'decision', 'emotion'];

export const RETENTION_ORDER: readonly MemoryRetention[] = [
  'forever',
  'untilSuperseded',
  'days90',
  'days30',
  'sessionOnly'
];

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  high: '可信度高',
  medium: '可信度中',
  low: '可信度低'
};

/**
 * 置信度因子里的来源说明，比 ORIGIN_LABELS 那组 chip 长：
 * chip 只要一个词，而这里是「凭什么信这条」的解释，必须把「未经用户确认」说出来。
 * 任务书 2.2 的红线是禁止把推断直接当成用户事实，所以措辞上不许含糊。
 */
const ORIGIN_CONFIDENCE_LABELS: Record<MemoryOrigin, string> = {
  explicit: '用户亲口说过',
  userConfirmed: '用户亲手确认过',
  observed: '系统观察到，未经用户确认',
  inferred: '系统推断，未经用户确认',
  hypothesis: '仅为假设',
  retracted: '已撤回'
};

/** 因子是结构化数据，中文只在这一层出现：算分的模块不该管界面怎么措辞。 */
export function describeConfidenceFactor(factor: ConfidenceFactor): string {
  switch (factor.kind) {
    case 'origin':
      return ORIGIN_CONFIDENCE_LABELS[factor.origin];
    case 'restated':
      return `在 ${factor.count} 个不同场合重复过`;
    case 'contradicted':
      return `存在 ${factor.count} 条相反证据`;
    case 'superseded':
      return '已被新说法取代';
    case 'expired':
      return '已过有效期';
    case 'retracted':
      return '已撤回';
  }
}

/**
 * 再巩固标记（任务书 7.1）的中文。三项，不是五项——
 * 「需要更新摘要」没有可检查的东西（MemoryItem 没有摘要列），「需要修改关联关系」有表但没有
 * 可自动判定的「该改哪条边」信号（`MemoryRelation` 只由带证据的写侧自动生成），
 * 所以不摆一个永远不亮的芯片，也不摆一个永远亮着的。
 * 措辞说凭据不说结论：标记只回答「这条值得回看一眼」，它不改置信度。
 */
export const RECONSOLIDATION_LABELS: Record<ReconsolidationFlag, string> = {
  newSupport: '记下之后又出现过新的支持信息',
  contradiction: '出现过相反的说法',
  outdated: '已经过了有效期'
};

/**
 * 「记忆」那一屏两份列表的截断说明（任务书 7.2 之后，当前有效和已归档各自有 `MEMORY_LIST_MAX_ROWS` 上限）。
 *
 * 条数取**实际列出的行数**，不把服务端的常量抄一份到界面：抄的那一份会先过期，
 * 而且被截断时两者必然相等。两句分开写而不是一句模板，是因为「归档比这一屏多」和
 * 「记忆比这一屏多」是两件不同的事——合成一句，用户就分不清少掉的那批在哪个桶里。
 * 口径与时间线的 `capped`、洞察那屏的 `describeListCap` 一致：不说出来，
 * 「这里没有更早的」就会被读成「更早的没发生过」。
 */
export function describeMemoryListCap(capped: boolean, shownCount: number): string {
  if (!capped) return '';
  return `记忆比这一屏多：这里只列出最近 ${shownCount} 条，更早的没有读进来。`;
}

export function describeArchivedListCap(capped: boolean, shownCount: number): string {
  if (!capped) return '';
  return `已归档的记忆比这一屏多：这里只列出最近 ${shownCount} 条，更早的没有读进来。`;
}

/**
 * 待确认那一池的截断说明，口径和上面两份一样：报的是服务端实际列出的条数。
 *
 * 这一句比另两份更要紧：被挤掉的是最旧的、用户一句都没答过的原话，它们还密文存在库里。
 * 不报出来，「这里就这几句」会被读成「系统只问过我这几句」。
 */
export function describeCandidateListCap(capped: boolean, shownCount: number): string {
  if (!capped) return '';
  return `等你回答的话比这一屏多：这里只列出最近 ${shownCount} 条，更早的没有读进来。`;
}

/**
 * 判死（不再重试）那五种情况的中文（任务书 §6 要求④）。
 *
 * 这五句是这一屏里唯一解释「系统为什么漏了」的文字，所以三句是硬要求：
 * 一、`timeout` 那一档不许说成「这句一定没记上」。服务端判它死恰恰是因为**不知道**写没写进去
 *    （`task-worker.ts`：超时之后重跑就是「同一句话记两条」的来源，所以宁可留下可查的 DEAD），
 *    句子必须把这份不知道留在原地。
 * 二、`preferences_unavailable` 那一档反过来：读不到开关发生在写之前（`settleTask` 第一道门），
 *    那一轮一个字都没动过库，所以「这句没记上」是确定的，不是猜的。
 * 三、`other` 那一档不猜原因。认不出来的错误码只可能是以后新增的，猜错的那句解释会被当成事实。
 *
 * 都不报次数：次数是 `attempts` 那一列自己说的（`describeFailedTaskAttempt`），
 * 写进标签里就等于把同一个数在两处各自过期。
 */
export const FAILED_TASK_REASON_LABELS: Record<FailedTaskReason, string> = {
  timeout: '写到一半超时：这句可能记上了，也可能没有',
  retry_exhausted: '重试过，每一次都失败',
  lease_expired: '负责它的服务中途断了',
  preferences_unavailable: '读不到你的记忆开关：这句没记上',
  other: '原因没有记下来'
};

/** 试过几次原样说，不写成「试过好几次」：那个数是这一行唯一的努力证据，含糊了就等于没有。 */
export function describeFailedTaskAttempt(attempts: number): string {
  return `试过 ${attempts} 次`;
}

/**
 * 判死列表的截断说明，口径和上面三份一样：报服务端实际列出的条数。
 * 这一句更要紧：被挤掉的是最旧的那些欠账，不报出来「就这几句没记上」会被读成「只漏了这几句」。
 */
export function describeFailedTaskListCap(capped: boolean, shownCount: number): string {
  if (!capped) return '';
  return `没记上的句子比这一屏多：这里只列出最近 ${shownCount} 条，更早的没有读进来。`;
}

/**
 * 任务书 7.1 的那次「被再次调用」在界面上的说法。
 *
 * 句子必须把**窗口**一起说出来：光讲「被带到 3 次」，用户读到的是一个没有边界的总数，
 * 而它只是最近若干轮的计数。轮数取服务端实际扫过的那一份（`accessWindow`），
 * 不把 `MEMORY_ACCESS_MAX_ROWS` 抄进界面——抄的那一份会先过期，截断时还是个假数。
 */
export function describeAccessCount(turns: number, count: number): string {
  return `最近 ${turns} 轮对话里被带到 ${count} 次`;
}

/** 窗口截断说明，口径和上面两份列表一样：不说出来，「更早的没带过」就会被当成「更早的没发生」。 */
export function describeAccessCap(capped: boolean, turns: number): string {
  if (!capped) return '';
  return `访问记录比这一屏多：这里只统计最近 ${turns} 轮对话，更早的轮次没有算进来。`;
}

export interface PolicySummaryInput {
  allowPersistence: boolean;
  allowedMemoryTypes: readonly MemoryType[];
  requireConfirmation: boolean;
  retention: MemoryRetention;
}

/** 收起态的一行摘要。多种限制同时成立时只说最紧的那一条，避免摘要变成一串自相矛盾的并列。 */
export function describePolicySummary(policy: PolicySummaryInput): string {
  if (!policy.allowPersistence) return '不保存';
  if (policy.requireConfirmation) return '先问再记';
  if (policy.allowedMemoryTypes.length === 0) return '允许保存 · 不记任何类型';
  return `允许保存 · 记 ${policy.allowedMemoryTypes.length} 种类型 · ${RETENTION_LABELS[policy.retention]}`;
}

/** 「年月日」这一套写法在项目里只有这一份（6-G 那次统一），聊天里的引用提示也走它。 */
export function formatDate(value: string, precision: TimePrecision): string {
  const date = new Date(value);
  const ymd = `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  if (precision === 'year') return `${date.getUTCFullYear()}年`;
  if (precision === 'month') return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`;
  if (precision !== 'timestamp') return ymd;
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${ymd} ${hh}:${mm}`;
}

/** 按精度回显有效区间，绝不显示比当初记录更精确的时间。 */
export function describeValidRange(
  memory: Pick<MemoryDto, 'precision' | 'validFrom' | 'validTo'>
): string {
  if (memory.precision === 'unknown' || !memory.validFrom) return '时间未知';
  const from = formatDate(memory.validFrom, memory.precision);
  if (!memory.validTo) return from;
  return `${from}～${formatDate(memory.validTo, memory.precision)}`;
}
