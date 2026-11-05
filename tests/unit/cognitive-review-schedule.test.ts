import { describe, expect, it } from 'vitest';
import { parseReviewAfter } from '@/lib/cognitive/review-schedule';

/**
 * 复盘时间（任务书 5.2 最后一列「可选的后续复盘时间」）。
 *
 * 这一列此前没有任何生产者：库里 reviewAfter 恒为 NULL，面板第五桶「待复盘」永远空着。
 * 这组用例钉的是它唯一的合法来源——用户自己说出的时长，以及认不出来时的那个 null。
 */
const NOW = new Date('2026-11-06T04:00:00Z');
const DAY_MS = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

describe('复盘时间只从用户说出口的时长里来', () => {
  it('「三个月后复盘」= 今天往后 90 天', () => {
    expect(parseReviewAfter('我打算三个月后复盘一下这次选型', NOW)).toEqual(days(90));
  });

  it('中文数字和阿拉伯数字同一个值：「3天后」和「三天后」不许差一天', () => {
    expect(parseReviewAfter('三天后我看结果', NOW)).toEqual(parseReviewAfter('3天后我看结果', NOW));
    expect(parseReviewAfter('3天后我看结果', NOW)).toEqual(days(3));
  });

  it('周按 7 天：「两周后」', () => {
    expect(parseReviewAfter('两周后再看数据', NOW)).toEqual(days(14));
  });

  it('半年按 6 个月，不是「半」这个字单独算', () => {
    expect(parseReviewAfter('半年后再回来看', NOW)).toEqual(days(180));
  });

  it('年按 365 天：「五年后」', () => {
    expect(parseReviewAfter('五年后这笔账才算得清', NOW)).toEqual(days(1825));
  });

  it('中文两位数字：「十天后」是 10 天，「二十天后」是 20 天', () => {
    expect(parseReviewAfter('十天后回头看', NOW)).toEqual(days(10));
    expect(parseReviewAfter('二十天后回头看', NOW)).toEqual(days(20));
  });

  it('认不出来就是 null，不许拿默认值填一个日子', () => {
    expect(parseReviewAfter('我决定把订单存储换成 PostgreSQL', NOW)).toBeNull();
    expect(parseReviewAfter('', NOW)).toBeNull();
  });

  it('「以后」「日后」没有时长：宁可空着，也不替用户宣布一个日期', () => {
    expect(parseReviewAfter('以后再看吧', NOW)).toBeNull();
    expect(parseReviewAfter('日后再说', NOW)).toBeNull();
    expect(parseReviewAfter('过些日子回头看', NOW)).toBeNull();
  });

  it('模糊的历法词不落库：「明年」「下个月」到具体哪一天是我们编的，不是他说的', () => {
    expect(parseReviewAfter('明年再看', NOW)).toBeNull();
    expect(parseReviewAfter('下个月回头看', NOW)).toBeNull();
  });

  it('过去不是复盘时间：「三个月前就定完了」', () => {
    expect(parseReviewAfter('三个月前就定完了', NOW)).toBeNull();
  });

  it('一句里两个时长标记 ⇒ null：没有依据挑一个，「取最近的那个」是我们编的规则', () => {
    expect(parseReviewAfter('两周后看一次，三个月后再复盘', NOW)).toBeNull();
  });

  it('句子里只有一个标记时，别处的字不许干扰它', () => {
    expect(parseReviewAfter('我觉得这次选早了，半年后再看一遍', NOW)).toEqual(days(180));
  });
});
