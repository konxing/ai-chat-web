import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTemporalFrame } from '@/lib/cognitive/temporal';
import type { TimePrecision } from '@/lib/cognitive/memories';

/**
 * 自然语言时间解析（任务书 Phase 4.2）——缩小版词表。
 *
 * 这一片唯一的存在理由是让 `memory-module` 写进去的记忆不再一律 `precision: 'unknown'`，
 * 所以红线只有一条主线的三个侧面：**给不出诚实的单点时间，就一律返回 null**，
 * 让调用方维持「时间未知」。宁可少解析出十个，也不能把一个错时刻写进库里——
 * 写错了比写空了难发现得多，用户看到的是时间线上一个言之凿凿的错误日期。
 *
 * 一、**词表就到这儿**（批准过的范围，语料实测里只有约 11% 的含时间句能诚实落地）：
 *    `今年 / 去年 / 前年`、`这个月 / 上个月`、`昨天 / 前天 / N天前`、绝对 `YYYY年M月D日 / YYYY年M月 / YYYY年 / YYYY-MM-DD`。
 *    词表之外没有任何时间表达——「今天」「3月5日」这种不带年份的月日都算词表外。
 *
 * 二、**未来的说法保持 unknown**（选定的 (a) 方案）。`明年 / 下个月 / 下周 / 明天`
 *    不在词表里，未来的绝对日期也要判掉：那是还没发生的事，
 *    落一个 validFrom 就是把计划讲成已经发生（评测故事 `s14-p3` 立的正是这条）。
 *
 * 三、**周档和循环事件不做**。`每周X / 周X / 上周 / 这周 / 下周` 一律 null：
 *    前者是 `validPrecision` 这个 Prisma enum 里根本没有的档位（加档要 `ALTER TYPE` 迁移），
 *    后者多数是习惯而不是时点——「每周三打球」落到某一个周三就是撒谎。
 *    这两条的后续靶子记在 docs/cognitive-acceptance.md。
 *
 * 产出的 Date 必须和精度严格对齐，因为写侧 `memories.ts:226-233` 会硬拦：
 * `day` 要求时间部分为 0、`month` 还要求 1 日、`year` 还要求 1 月 1 日。
 * 解析器给出「2026年3月17日 14:25」这种带着墙上时钟分秒的时刻，会被服务端整个拒掉。
 */

/** 一句普通的话：2026-11-03 是周二，不在任何月/年边界上， off-by-one 在这里藏不住。 */
const SAID_AT = '2026-11-03T14:25:31.000Z';

function frame(text: string, saidAt = SAID_AT) {
  return resolveTemporalFrame(text, new Date(saidAt));
}

/** 复刻写侧那道闸门（`memories.ts:226-233`）：精度不许比记下来的更精确。 */
function expectAlignedToPrecision(precision: TimePrecision, date: Date): void {
  const clock = date.getTime() % 86_400_000;
  expect(clock).toBe(0);
  if (precision === 'month') expect(date.getUTCDate()).toBe(1);
  if (precision === 'year') {
    expect(date.getUTCDate()).toBe(1);
    expect(date.getUTCMonth()).toBe(0);
  }
}

describe('解析：词表内的说法给出与精度对齐的有效起点', () => {
  const RESOLVES: readonly { text: string; precision: TimePrecision; validFrom: string }[] = [
    // 相对年
    { text: '我今年换了工作。', precision: 'year', validFrom: '2026-01-01T00:00:00.000Z' },
    { text: '去年我还在上一家公司。', precision: 'year', validFrom: '2025-01-01T00:00:00.000Z' },
    { text: '前年体检一切正常。', precision: 'year', validFrom: '2024-01-01T00:00:00.000Z' },
    // 相对月
    { text: '这个月在戒咖啡。', precision: 'month', validFrom: '2026-11-01T00:00:00.000Z' },
    { text: '上个月底交了房租。', precision: 'month', validFrom: '2026-10-01T00:00:00.000Z' },
    // 相对日
    { text: '昨天去医院复查了。', precision: 'day', validFrom: '2026-11-02T00:00:00.000Z' },
    { text: '前天晚上失眠了。', precision: 'day', validFrom: '2026-11-01T00:00:00.000Z' },
    // 跨月：11-03 往前三天是 10-31
    { text: '3天前我把报告发给他了。', precision: 'day', validFrom: '2026-10-31T00:00:00.000Z' },
    // 绝对年月日
    { text: '2025年3月5日签的合同。', precision: 'day', validFrom: '2025-03-05T00:00:00.000Z' },
    { text: '2025-03-05 签的合同。', precision: 'day', validFrom: '2025-03-05T00:00:00.000Z' },
    { text: '2025年3月开始做的这个项目。', precision: 'month', validFrom: '2025-03-01T00:00:00.000Z' },
    { text: '2025年结的婚。', precision: 'year', validFrom: '2025-01-01T00:00:00.000Z' }
  ];
  it.each(RESOLVES)('$text → $precision $validFrom', ({ text, precision, validFrom }) => {
    const result = frame(text);
    expect(result).not.toBeNull();
    expect(result?.precision).toBe(precision);
    expect(result?.validFrom.toISOString()).toBe(validFrom);
    expectAlignedToPrecision(precision, result!.validFrom);
  });

  it('跨年往回：1 月说「上个月」落到去年 12 月', () => {
    expect(frame('上个月去的医院', '2026-01-15T08:00:00.000Z')).toEqual({
      precision: 'month',
      validFrom: new Date('2025-12-01T00:00:00.000Z')
    });
  });

  it('跨年往回：元旦说「昨天」落到去年 12 月 31 日', () => {
    expect(frame('昨天是跨年夜', '2026-01-01T00:30:00.000Z')).toEqual({
      precision: 'day',
      validFrom: new Date('2025-12-31T00:00:00.000Z')
    });
  });

  it('元旦当天说「今年」：有效起点就是这一时刻，不算未来', () => {
    expect(frame('今年开始跑步', '2026-01-01T00:00:00.000Z')).toEqual({
      precision: 'year',
      validFrom: new Date('2026-01-01T00:00:00.000Z')
    });
  });

  it('年末说「这个月」不会滑到明年', () => {
    expect(frame('这个月加班很多', '2026-12-31T23:59:00.000Z')).toEqual({
      precision: 'month',
      validFrom: new Date('2026-12-01T00:00:00.000Z')
    });
  });

  it('只按传进来的说话时间算，绝不读墙上时钟', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2000-06-06T06:06:06.000Z'));
    try {
      expect(frame('我今年换了工作。')).toEqual({
        precision: 'year',
        validFrom: new Date('2026-01-01T00:00:00.000Z')
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('时间表达嵌在长句中间也认得出来', () => {
    expect(frame('孩子出生后我把书房改成了儿童房，去年又改回去了')).toEqual({
      precision: 'year',
      validFrom: new Date('2025-01-01T00:00:00.000Z')
    });
  });

  it('「今年3月」不带年份的月日照词表外处理：只落年，不猜月份', () => {
    expect(frame('今年3月去的日本')).toEqual({
      precision: 'year',
      validFrom: new Date('2026-01-01T00:00:00.000Z')
    });
  });
});

describe('相对说法锚用户墙钟：tzOffsetMinutes 只决定「昨天是哪一天」', () => {
  it('UTC+8 本地清晨说「昨天」：落在本地昨天，按 UTC 日界会多退一天', () => {
    // saidAt = 2026-11-06T16:30Z = 本地 11-07 00:30；「昨天」是本地 11-06，不是 UTC 的 11-05。
    expect(resolveTemporalFrame('昨天去医院复查了', new Date('2026-11-06T16:30:00.000Z'), 480)).toEqual({
      precision: 'day',
      validFrom: new Date('2026-11-06T00:00:00.000Z')
    });
    // 同一时刻不传偏移 = 老行为（UTC 日界）。
    expect(resolveTemporalFrame('昨天去医院复查了', new Date('2026-11-06T16:30:00.000Z'))?.validFrom.toISOString()).toBe(
      '2026-11-05T00:00:00.000Z'
    );
  });

  it('UTC+8 本地元旦凌晨说「去年」：是去年，按 UTC 取年会再错退一年', () => {
    // saidAt = 2025-12-31T16:30Z = 本地 2026-01-01 00:30。
    expect(resolveTemporalFrame('去年结的婚', new Date('2025-12-31T16:30:00.000Z'), 480)).toEqual({
      precision: 'year',
      validFrom: new Date('2025-01-01T00:00:00.000Z')
    });
  });

  it('UTC+8 本地月初说「上个月」：月份按本地日历取', () => {
    // saidAt = 2026-10-31T16:30Z = 本地 11-01 00:30。
    expect(resolveTemporalFrame('上个月底交了房租', new Date('2026-10-31T16:30:00.000Z'), 480)).toEqual({
      precision: 'month',
      validFrom: new Date('2026-10-01T00:00:00.000Z')
    });
  });

  it('落库仍是 UTC 零点的日历日：精度闸门不放行带时区偏移的时刻', () => {
    const result = resolveTemporalFrame('前天晚上失眠了', new Date('2026-11-06T16:30:00.000Z'), 480);
    expect(result?.precision).toBe('day');
    expectAlignedToPrecision('day', result!.validFrom);
  });

  it('未来判定不受偏移影响：还没发生的绝对日期照样 null', () => {
    expect(resolveTemporalFrame('2027年1月1日搬的家', new Date('2026-11-06T16:30:00.000Z'), 480)).toBeNull();
  });
});

describe('拒绝：给不出诚实的单点时间就返回 null', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    // 句子里根本没有时间表达
    { text: '我在做 family-ai-chat。', why: '无时间表达' },
    { text: '', why: '空串' },
    // (a) 方案：未来的说法一律 unknown
    { text: '明年打算把体检做完。', why: '未来的年' },
    { text: '下个月开始复查。', why: '未来的月' },
    { text: '明天去医院。', why: '未来的日' },
    { text: '2027年5月1日开会。', why: '未来的绝对日期' },
    // 周档不在 enum 里，循环事件不是时点
    { text: '每周三晚上打球。', why: '循环事件' },
    { text: '周三通常不加班。', why: '周指' },
    { text: '上周体检了一切正常。', why: '没有周档' },
    { text: '这周比较忙。', why: '没有周档' },
    { text: '下周复查血糖。', why: '未来的周指' },
    // 一句里两个以上不同的时间表达，分不清这句说的是哪个时刻
    { text: '今年3月我去过日本，去年也去过。', why: '两个不同时间表达' },
    { text: '2025年和2026年都搬过一次家。', why: '两个绝对年' },
    { text: '昨天和前天都没睡好。', why: '两个相对日' },
    // 词表外的形状：不带年份的月日认不出是哪一年
    { text: '3月5日开始上班。', why: '月日不带年份' },
    { text: '12月的房租交了。', why: '只有月不带年份' },
    // 日历上不存在的日子不许悄悄滚到别的一天
    { text: '2025年2月30日办的手续。', why: '不存在的日' },
    { text: '2025年13月办的手续。', why: '不存在的月' }
  ])('$why：$text', ({ text }) => {
    expect(frame(text)).toBeNull();
  });

  it('未来与词表都以传入的说话时间为准：同一句「2026年」在 2027 年说是过去的', () => {
    expect(frame('2026年结的婚', '2027-06-01T10:00:00.000Z')).toEqual({
      precision: 'year',
      validFrom: new Date('2026-01-01T00:00:00.000Z')
    });
  });

  it('绝对日期落在说这句话之后判为未来：同一句在 2025 年说就是未来', () => {
    expect(frame('2026年结的婚', '2025-06-01T10:00:00.000Z')).toBeNull();
  });
});
