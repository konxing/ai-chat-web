import type { TimePrecision } from './memories';

/**
 * 自然语言时间解析（任务书 Phase 4.2）：把一句用户原话里的时间说法读成一个有效起点。
 *
 * 只服务一个消费者——`memory-module` 写入时决定 `precision` / `validFrom`。
 * 所以它的契约是反向的：**解析不出来是正常结果**，调用方维持 `unknown`；
 * 而解析出来的那个时刻必须是这句话真的在说的那个时刻。写错比写空难发现得多，
 * 用户会在时间线上看到一个言之凿凿的错日期。
 *
 * 三条形状：
 *
 * 一、**整句只容得下一个时间标记**。句子里出现两个（哪怕其中一个是重复）就返回 null，
 *    因为我们没有依据判断这句讲的是哪个时刻，而「取最近的那个」是我们编的规则，不是用户说的。
 *
 * 二、**未来的说法不落 validFrom**。整个方案选的是「未来一律 unknown」：
 *    `明年 / 下个月 / 明天` 这类词压根不在词表里，绝对写法则由 `validFrom > saidAt` 判掉。
 *    把计划写成已经发生，是任务书在检索那一侧也立过的红线（评测故事 `s14-p3`）。
 *
 * 三、**不给 validTo**。「去年在学吉他」的去年只是一个起点；这段说法到什么时候失效我们并不知道，
 *    填一个年末等于替用户宣布「今年就不学了」。开区间由 `validTo === null` 表达。
 *
 * 时刻一律用 UTC 日界对齐，因为写侧 `memories.ts:226-233` 硬拦「精度比记下来的更精确」：
 * `day` 要求时间部分为 0、`month` 还要求 1 日、`year` 还要求 1 月 1 日。
 * 顺带一句：不做本地时区换算，因为用户的时区没有存，而 `saidAt` 本身就是一个 UTC 时刻。
 */

export interface TemporalFrame {
  precision: TimePrecision;
  validFrom: Date;
}

const DAY_MS = 86_400_000;

/**
 * 词表。绝对写法排在相对词之前，正则在同一位置按分支顺序取第一条命中的，
 * 所以 `2025年3月5日` 算**一个**标记，而不是「2025年 + 3月 + 5日」三个。
 *
 * 不带年份的 `3月5日` 不在表里——这一条同时解决两件事：认不出是哪一年，该返回 null；
 * 而「今年3月」这种年词加裸月的组合只落年，不会因为我们猜月份而写进一个错的起点。
 */
const TOKEN_RE =
  /(\d{4})年(\d{1,2})月(\d{1,2})日|(\d{4})年(\d{1,2})月|(\d{4})年|(\d{4})-(\d{1,2})-(\d{1,2})|([今去前])年|这个月|上个月|昨天|前天|(\d{1,3})天前/g;

export function resolveTemporalFrame(text: string, saidAt: Date): TemporalFrame | null {
  const matches = [...text.matchAll(TOKEN_RE)];
  if (matches.length !== 1) return null;

  const frame = frameOf(matches[0], saidAt);
  if (!frame) return null;
  // 未来的时刻：这句说的是还没发生的事，落进 validFrom 就是把计划讲成已经发生。
  if (frame.validFrom.getTime() > saidAt.getTime()) return null;
  return frame;
}

function frameOf(match: RegExpMatchArray, saidAt: Date): TemporalFrame | null {
  const [token, y1, m1, d1, y2, m2, y3, y4, m4, d4, yearWord, daysAgo] = match;

  if (y1) return absolute('day', Number(y1), Number(m1), Number(d1));
  if (y2) return absolute('month', Number(y2), Number(m2), 1);
  if (y3) return absolute('year', Number(y3), 1, 1);
  if (y4) return absolute('day', Number(y4), Number(m4), Number(d4));

  const year = saidAt.getUTCFullYear();
  const month = saidAt.getUTCMonth();
  if (yearWord) {
    return { precision: 'year', validFrom: new Date(Date.UTC(year - (yearWord === '今' ? 0 : yearWord === '去' ? 1 : 2), 0, 1)) };
  }
  // Date.UTC 吃负数月：1 月说「上个月」自己滚到去年 12 月，不用额外判。
  if (token === '这个月') return { precision: 'month', validFrom: new Date(Date.UTC(year, month, 1)) };
  if (token === '上个月') return { precision: 'month', validFrom: new Date(Date.UTC(year, month - 1, 1)) };

  const days = token === '昨天' ? 1 : token === '前天' ? 2 : Number(daysAgo);
  return {
    precision: 'day',
    validFrom: new Date(Math.floor(saidAt.getTime() / DAY_MS) * DAY_MS - days * DAY_MS)
  };
}

/** 日历上不存在的日子（2月30日、13月）不许悄悄滚到隔壁那天：回读一遍对不上就判 null。 */
function absolute(precision: TimePrecision, year: number, month: number, day: number): TemporalFrame | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }
  return { precision, validFrom: date };
}
