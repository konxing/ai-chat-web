/**
 * 选择性时间上下文。只在对话与"时钟/日历时间"相关时，才把当前本地时间注入提示词；
 * 与时间无关的对话不传，避免无谓占用上下文、也避免模型主动报时。
 *
 * 判定为纯规则、零模型调用；时区用用户已保存的 timezoneOffsetMinutes（与记忆相对时间同口径）。
 */

// 时钟/日历信号。故意不收裸"时间"（"时间复杂度"是算法概念，不是报时需求）。
const TIME_RE =
  /今天|明天|昨天|后天|前天|现在|当前|目前|此刻|几点|什么时候|什么时间|日期|几号|星期|周[一二三四五六日末]|本周|下周|上周|这周|本月|下月|上月|今年|去年|明年|上午|下午|晚上|凌晨|早上|中午|傍晚|最近|多久|多长时间|截止|日程|安排|提醒|倒计时|生日|节日|节气|周末|工作日|点钟|点半|\b(?:today|tomorrow|yesterday|now|currently|date|weekday|weekend|deadline|schedule|o'clock|a\.m\.|p\.m\.)\b/i;

export function isTimeRelevant(texts: readonly string[]): boolean {
  return texts.some((t) => TIME_RE.test(t));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 生成一行当前本地时间（用户时区偏移分钟，null 视为 UTC+0）。 */
export function timeContextLine(timezoneOffsetMinutes: number | null, now: Date = new Date()): string {
  const offset = Number.isFinite(timezoneOffsetMinutes) ? (timezoneOffsetMinutes as number) : 0;
  const local = new Date(now.getTime() + offset * 60_000);
  const y = local.getUTCFullYear();
  const m = pad(local.getUTCMonth() + 1);
  const d = pad(local.getUTCDate());
  const hh = pad(local.getUTCHours());
  const mm = pad(local.getUTCMinutes());
  const wd = WEEKDAYS[local.getUTCDay()];
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const tz = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `当前时间：${y}-${m}-${d} ${hh}:${mm}（${wd}，用户本地时区 ${tz}）。` +
    '仅当用户问题涉及时间/日期/日程时以此为准；不要主动报时，不要编造其它日期。'
  );
}