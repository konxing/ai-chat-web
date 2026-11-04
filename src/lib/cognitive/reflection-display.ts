import type { ReflectionCitationKind, ReflectionStatus, ReflectionType, TimePrecision } from '@prisma/client';

/**
 * 洞察一屏的展示词汇与时间降级规则。
 *
 * 和 memory-display.ts 同一个来由：reflections.ts / policy.ts 都 import 了 prisma，
 * 客户端组件只要拿几个标签，直接引用就会把数据库驱动拖进浏览器包。所以这里只放纯函数和常量，
 * 类型全部走 `import type`（编译期抹掉）。边界由 tests/unit/cognitive-reflection-display.test.ts 钉住。
 *
 * 文案主体是 2026-11-04 批准的逐字表；「生成于 …」和「洞察比这一屏多…」两句是他同日让我自拟的，
 * 日期口径同日统一到时间线那一屏的「年月日」。改这里就是改用户看到的句子，要重新批准。
 */

export const REFLECTION_TYPE_LABELS: Record<ReflectionType, string> = {
  PATTERN: '反复出现的模式',
  GOAL_DRIFT: '目标偏移',
  UNRESOLVED: '悬而未决',
  INTEREST_SHIFT: '兴趣转移',
  CONTRADICTION: '前后矛盾',
  MILESTONE: '里程碑',
  DECISION_LESSON: '决策教训'
};

/**
 * 六个区 = 六个状态（11-04 判的甲）。全列而不是只列待处理，是因为门槛 7 要的是
 * 「每个状态都有生产者」，而生产者写出来的东西如果界面上永远看不见，那条状态就没被验收过。
 */
export const REFLECTION_SECTIONS: ReadonlyArray<{ status: ReflectionStatus; title: string }> = [
  { status: 'PENDING', title: '待处理' },
  { status: 'SNOOZED', title: '稍后' },
  { status: 'ACCEPTED', title: '已采纳' },
  { status: 'EDITED', title: '已改写' },
  { status: 'REJECTED', title: '已拒绝' },
  { status: 'EXPIRED', title: '已过期' }
];

export const CITATION_KIND_LABELS: Record<ReflectionCitationKind, string> = {
  SUPPORTS: '支撑：',
  CONTRADICTS: '相反：'
};

/** 只有 3/7/30：与服务端的白名单同宽，少一档或多一档都会在点下去时收到 400。 */
export const REFLECTION_SNOOZE_OPTIONS: ReadonlyArray<{ days: 3 | 7 | 30; label: string }> = [
  { days: 3, label: '3 天' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' }
];

/**
 * 状态机的入口只有 PENDING（reflections.ts 的 setReflectionStatus），所以别的状态摆按钮
 * 就是摆一个必然 409 的控件。稍后也不算「还能改」——到时间由后台放回待处理。
 */
export function isActionable(status: ReflectionStatus): boolean {
  return status === 'PENDING';
}

function formatAt(value: string, precision: TimePrecision): string {
  const date = new Date(value);
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  // 每低一档就只输出到那一档，绝不显示比当初记录更精确的时间（任务书 4.2、门槛 6）。
  // 写法与 memory-display.ts 的 formatDate 同一套「年月日」：11-04 判的统一，同一项目里
  // 同一种精度不该在两屏上长得不一样。
  if (precision === 'YEAR') return `${y}年`;
  if (precision === 'MONTH') return `${y}年${mo}月`;
  const ymd = `${y}年${mo}月${d}日`;
  if (precision !== 'TIMESTAMP') return ymd;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ymd} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** 精度未知或压根没有时间 ⇒ 空串，由界面决定这一行整体不渲染，而不是显示「未知」占位。 */
export function describeReflectionTime(
  timeFrom: string | null,
  timeTo: string | null,
  precision: TimePrecision
): string {
  if (precision === 'UNKNOWN' || timeFrom === null) return '';
  const from = formatAt(timeFrom, precision);
  if (timeTo === null) return from;
  return `${from}～${formatAt(timeTo, precision)}`;
}

/** 样本数与观察跨度是「证据不足」判据本身（任务书 6.3），所以要摊开给用户看。 */
export function describeEvidenceVolume(sampleCount: number, observationSpanDays: number): string {
  return `基于 ${sampleCount} 条记忆，跨 ${observationSpanDays} 天`;
}

export function describeCounterEvidence(counterHitCount: number): string {
  return counterHitCount === 0 ? '' : `找到 ${counterHitCount} 条相反的证据`;
}

export function describeAlternatives(alternatives: string | null): string {
  if (alternatives === null || alternatives.trim() === '') return '';
  return `另一种解释：${alternatives}`;
}

/** 「已推迟到 {日期}」里的日期：推迟按整天计，所以到日为止，不露时分。 */
export function formatSnoozeDate(snoozedUntil: string): string {
  const date = new Date(snoozedUntil);
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

/**
 * 这条洞察是什么时候生成的一行说明。
 *
 * `generatedAt` 是系统盖的时间戳，精度本来就是完整的，所以到日不违反门槛 6——那条禁的是
 * 把粗精度说成细，反过来说细的没有意义，只会让卡片变吵。
 */
export function describeGeneratedAt(generatedAt: string): string {
  const date = new Date(generatedAt);
  return `生成于 ${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

/**
 * 列表被 `REFLECTION_LIST_MAX_ROWS` 截断时的说明。不截断就不留一行空话。
 *
 * 条数取**实际列出的行数**而不是把服务端那个常量抄一份到界面：抄的那一份会先过期，
 * 而且被截断时两者必然相等。这一句存在的理由和时间线那屏的 `capped` 一样——不说出来，
 * 用户会把「这里没有更早的」读成「更早的没发生过」，那正是门槛 4 最不想看到的读法。
 */
export function describeListCap(capped: boolean, shownCount: number): string {
  if (!capped) return '';
  return `洞察比这一屏多：这里只列出最近 ${shownCount} 条，更早的没有读进来。`;
}
