import type { MemoryDto, MemoryOrigin, MemoryRevisionAction, TimePrecision } from './memories';
import type { MemoryContext, MemoryType } from './policy';

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

function formatDate(value: string, precision: TimePrecision): string {
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
