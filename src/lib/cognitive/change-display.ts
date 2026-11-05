import type { ChangeSignal, ChangeSubject, InsufficientChangeReason } from './change-detector';

/**
 * 变化检测（任务书 4.3）的展示词汇。
 *
 * 检测层刻意一个字的判断都不写，这里就是句子唯一的出处：两边各写一半，
 * 最后落在屏幕上的那句取决于谁后跑。和 `reflection-display.ts` 同一个来由，
 * 这一份也只放常量和纯函数——`change-detector.ts` import 了 prisma 的枚举，
 * 客户端组件只要拿几个标签，直接引用就会把数据库驱动拖进浏览器包，
 * 所以类型全部走 `import type`（编译期抹掉）。
 *
 * 句子只有主题 + 信号，不带任何「说明了你是什么」：任务书在 4.3 点名
 * 不允许根据极少数聊天记录预测用户未来人生或生成确定性人格结论。
 * 这一条不靠自觉，靠 tests/unit/cognitive-change-display.test.ts 里那组静态断言。
 *
 * 证据量那一句（「基于 N 条记忆，跨 M 天」）复用 `reflection-display.ts` 的
 * `describeEvidenceVolume`，不在这里再写一遍——同一个数字在两屏上长出两种说法，
 * 用户就会怀疑其中一个是随手写的。
 *
 * 测试：tests/unit/cognitive-change-display.test.ts
 */

export const CHANGE_SUBJECT_LABELS: Record<ChangeSubject, string> = {
  INTEREST: '兴趣',
  GOAL: '目标',
  PROJECT: '项目',
  PREFERENCE: '偏好',
  REPETITION: '反复提到的事',
  UNRESOLVED: '没有下文的事'
};

export const CHANGE_SIGNAL_LABELS: Record<ChangeSignal, string> = {
  EMERGED: '最近才反复提到',
  SHIFTED: '从一件转到了另一件',
  CHANGED: '说法换过一版',
  COMPLETED: '出现了完成说法',
  WITHDRAWN: '这句话被撤回',
  UPDATED: '多了一版说法',
  RECURRING: '一直在反复提到',
  STILL_OPEN: '放了很久没再提'
};

/**
 * 差在哪条门槛。`BELOW_OUTCOME_MIN` 属于 Phase 7 的决策教训，不在 4.3 的六件事里，
 * 所以这张表只覆盖检测层允许报出的那五种理由——少一列编译就过不去。
 */
export const INSUFFICIENT_CHANGE_LABELS: Record<InsufficientChangeReason, string> = {
  BELOW_SAMPLE_MIN: '提到的次数还不够',
  BELOW_CHAT_MIN: '只出现在同一个对话里',
  BELOW_SPAN_MIN: '提到的时间还太集中',
  BELOW_AGE_MIN: '放下的时间还不够久',
  BELOW_MEDIAN_GAP: '两件事的时间离得还不够远'
};

export const CHANGE_BEFORE_LABEL = '之前：';
/** 撤回没有「之后」的那一版：这一侧没有内容时整行不渲染，而不是留一个空标签。 */
export const CHANGE_AFTER_LABEL = '之后：';

/** 这一屏的常驻说明：观察的交付形态就是「带计数的观察」，不是一句判断。 */
export const CHANGES_ARE_OBSERVATIONS_NOTE = '下面每一条都只是观察：写明它依据几条记忆、跨多少天，不下结论。';

/**
 * 「兴趣」在库里没有对应的记忆类型，检测层只能用偏好和目标两类行代表它。
 * 这一句存在是因为不写出来，用户就会把这一栏读成系统真的懂他的兴趣。
 */
export const INTEREST_SOURCE_NOTE = '系统没有单独的「兴趣」记录，这一栏的兴趣只看偏好和目标两类说法。';

export const CHANGES_EMPTY_NOTE = '这次读进来的记忆里，还没有够得上任何一类观察的。';

export function describeChangeSignal(subject: ChangeSubject, signal: ChangeSignal): string {
  return `${CHANGE_SUBJECT_LABELS[subject]}：${CHANGE_SIGNAL_LABELS[signal]}`;
}

export function describeInsufficientChange(subject: ChangeSubject, reason: InsufficientChangeReason): string {
  return `${CHANGE_SUBJECT_LABELS[subject]}：${INSUFFICIENT_CHANGE_LABELS[reason]}`;
}

/** 来源决定这句话能被信任到什么程度：推断出来的观察不许长得像用户说过的。 */
export function describeChangeConfirmation(confirmed: boolean): string {
  return confirmed ? '依据里有亲口说过或确认过的说法' : '由记录推断，未经你确认';
}

/**
 * 读满一批时的说明。不截断就返回空串，界面上不留一行没有信息量的话。
 *
 * 「这一批里没有」和「更早没有发生过」是两件不同的事，而观察这一屏全靠「没看见就是没有」
 * 被读——时间线那屏的 `capped` 和洞察那屏的 `describeListCap` 都是为堵这个读法存在的。
 */
export function describeChangesCap(capped: boolean): string {
  if (!capped) return '';
  return '记忆条数已达上限：变化只看最近这一批记忆算出来的，更早的没有读进来。';
}
