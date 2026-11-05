/**
 * 复盘时间解析（任务书 5.2 的最后一列：「可选的后续复盘时间」）。
 *
 * 这一列在库里躺了很久，但此前没有任何一处写过它——`reviewAfter` 恒为 NULL，
 * 面板的「待复盘」桶因此永远空着。这片给它一个生产者，而生产者只认用户自己说出口的时长。
 *
 * 为什么不复用 `temporal.ts`：那个模块的契约和这一条**正好相反**。它服务的是记忆的有效起点，
 * 所以刻意把「明年 / 下个月 / 明天」整类未来说法判成 null（`temporal.ts:16-18`），
 * 因为把计划写成已经发生是检索侧的红线。这里要的恰恰是那个未来时刻，两者不能共用一张词表。
 *
 * 四条规则，方向都是「认不出来就空着」：
 *
 * 一、**必须有数量**。`以后 / 日后 / 过些日子` 一个都不落——那些话里没有日期，
 *     填一个就是替用户宣布他没说过的安排。
 * 二、**模糊历法词不落**。`明年 / 下个月 / 年底` 到具体哪一天是我们挑的，不是他说的。
 * 三、**一句里两个时长标记 ⇒ null**。和 `temporal.ts` 第一条同因：没有依据挑一个，
 *     「取最近的那个」是我们编的规则。
 * 四、**过去不是复盘时间**。`三个月前` 由形状直接排除（只认「…后」）。
 *
 * 口径：天=1、周=7、月=30、年=365，半 = 0.5 个单位；唯一的例外是「半年」= 6 个月 = 180 天，
 * 因为那是汉语里「六个月」的说法，不是 0.5×365。月和年按定长换算是一个**口径**不是历法，
 * 差一两天对「该回头看一眼了」这个徽标没有影响；真要按月日推算需要用户的时区，
 * 而时区没有存——同一个理由见 `temporal.ts:25`。
 *
 * 测试：tests/unit/cognitive-review-schedule.test.ts
 */
const DAY_MS = 86_400_000;

const UNIT_DAYS: Record<string, number> = { 天: 1, 周: 7, 月: 30, 年: 365 };

const SINGLE_DIGITS = '[一二两三四五六七八九]';
/** 数量：阿拉伯数字最多三位；中文覆盖 `十 / 十X / X十 / X十Y` 和单字。 */
const AMOUNT = `(?:\\d{1,3}|${SINGLE_DIGITS}?十${SINGLE_DIGITS}?|${SINGLE_DIGITS})`;

const DURATION_RE = new RegExp(`(${AMOUNT}|半)\\s*个?\\s*([天周年月])\\s*(?:之|以)?后`, 'g');

function amountValue(raw: string): number | null {
  if (raw === '半') return 0.5;
  if (/^\d+$/.test(raw)) return Number(raw);
  const digit = (ch: string | undefined): number | null =>
    ch === undefined ? null : ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })[ch] ?? null;
  const tensIndex = raw.indexOf('十');
  if (tensIndex === -1) return digit(raw);
  const tens = tensIndex === 0 ? 1 : digit(raw[0]);
  const units = raw.length > tensIndex + 1 ? digit(raw[raw.length - 1]) ?? 0 : 0;
  return tens === null ? null : tens * 10 + units;
}

export function parseReviewAfter(text: string, now: Date): Date | null {
  const hits = [...text.matchAll(DURATION_RE)];
  if (hits.length !== 1) return null;
  const [amount, unit] = [hits[0]![1]!, hits[0]![2]!];
  if (amount === '半' && unit === '年') return new Date(now.getTime() + 6 * UNIT_DAYS['月']! * DAY_MS);
  const count = amountValue(amount);
  if (count === null) return null;
  return new Date(now.getTime() + count * UNIT_DAYS[unit]! * DAY_MS);
}

/**
 * 这句话里有没有一个说得出时长的安排。存在的理由是界线，不是为了算日期：
 * 「预计三个月后再看一次」既是「预计…」开头又是安排，`decision-extractor` 需要把它
 * 从「预期结果」里排除掉——否则同一个分句会在两列里各存一遍，而它明明只说了复盘时间。
 */
export function hasReviewSchedule(text: string): boolean {
  return [...text.matchAll(DURATION_RE)].length > 0;
}
