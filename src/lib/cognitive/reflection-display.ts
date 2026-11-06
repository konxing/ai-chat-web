import type { ReflectionCitationKind, ReflectionStatus, ReflectionType, TimePrecision } from '@prisma/client';
import type { ConfidenceBand } from './confidence';

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

/**
 * 待处理那一区的两个子区标题（6.6「第一版最多保留 3 条待确认的高价值洞察作为主要展示」）。
 * 只给词、不给数：数已经在区级标题上（「待确认（N）」），子区再拼一个数等于把同一批行数字讲两遍，
 * 而两个子区的和恰好等于它——界面一旦自己算，就多了一个能和上面对不上的地方。
 * 两个词都要短，因为它们挤在区级标题下面。
 */
export const PENDING_SUBSECTION_LABELS = { primary: '主要', rest: '其余' } as const;

export interface ReflectionGroup<T> {
  key: string;
  /** null 表示这一区不需要小标题。 */
  title: string | null;
  rows: T[];
}

/**
 * 按服务端给的 `isPrimary` 把待处理的行切成两块。这里**不排序也不重新判定**：
 * 额度是 3、尺子是 importance，两样都只有读侧看得见——理由与片Q-3「分数不出服务端」是同一条，
 * 界面一旦自己排一次，「库里选出的前三」和「屏幕上看到的前三」就会分叉。
 *
 * 全主要或全不主要都回一整块且不带标题。前者那时「主要」就是这一区本身，挂标题等于把同一句
 * 话讲两遍；后者是读侧今天不会给的形状，但宁可整块摆出来，也不挂一个下面空着的标题。
 */
export function splitPendingSection<T extends { isPrimary: boolean }>(
  rows: ReadonlyArray<T>
): ReflectionGroup<T>[] {
  const primary = rows.filter((row) => row.isPrimary);
  if (primary.length === 0 || primary.length === rows.length) {
    return [{ key: 'all', title: null, rows: [...rows] }];
  }
  return [
    { key: 'primary', title: PENDING_SUBSECTION_LABELS.primary, rows: primary },
    {
      key: 'rest',
      title: PENDING_SUBSECTION_LABELS.rest,
      rows: rows.filter((row) => !row.isPrimary)
    }
  ];
}

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

/**
 * 解释那一行的前缀。主语是「还没分开」而不是「另一种」：这一行给的是并排的几种可能，
 * 系统一条都没选，所以它不能写得像「我还给你另一个说法」那种附带结论。
 */
export const ALTERNATIVES_LINE_PREFIX = '这几种解释还没分开：';

export function describeAlternatives(alternatives: string | null): string {
  if (alternatives === null || alternatives.trim() === '') return '';
  return `${ALTERNATIVES_LINE_PREFIX}${alternatives}`;
}

/**
 * 置信度那一颗 chip。刻意不叫「可信度」——那是 memory-display.ts 里 `CONFIDENCE_BAND_LABELS`
 * 的名字，它答的是「这一句可不可信」，阈值 0.75/0.45；这里的档位答的是「这几句够不够拼成
 * 同一件事」，阈值 0.7/0.4（见 reflection-evidence.ts 的 HIGH_BAND_MIN）。
 * 两个不同的算法共用一个词，用户就读不出差别，那等于给同一屏里两个数撒了同一个谎。
 *
 * 出的也只有档位没有分数：`row.confidence` 是规则算出来的三位小数，
 * 摆成 0.62 就会被当成精确真理读（记忆屏 1b 同一个口径）。
 */
export const REFLECTION_CONFIDENCE_LABELS: Record<ConfidenceBand, string> = {
  high: '把握大',
  medium: '把握中',
  low: '把握小'
};

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
