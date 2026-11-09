import { describe, expect, it } from 'vitest';
import { isTimeRelevant, timeContextLine } from '@/lib/time-context';

describe('选择性时间上下文：相关才注入', () => {
  it('时钟/日历信号判为相关', () => {
    expect(isTimeRelevant(['现在几点了？'])).toBe(true);
    expect(isTimeRelevant(['明天要开会，帮我列个提纲'])).toBe(true);
    expect(isTimeRelevant(['今天天气怎么样'])).toBe(true);
    expect(isTimeRelevant(['这个 deadline 是什么时候'])).toBe(true);
    expect(isTimeRelevant(['周末去哪玩'])).toBe(true);
  });

  it('与时间无关不注入（含"时间复杂度"这类算法概念）', () => {
    expect(isTimeRelevant(['帮我写个排序函数'])).toBe(false);
    expect(isTimeRelevant(['时间复杂度怎么算？'])).toBe(false);
    expect(isTimeRelevant(['我喜欢喝咖啡'])).toBe(false);
    expect(isTimeRelevant([])).toBe(false);
  });

  it('最近多轮里任一相关即注入', () => {
    expect(isTimeRelevant(['帮我写个函数', '顺便看看现在几点'])).toBe(true);
  });
});

describe('timeContextLine：用户时区', () => {
  const now = new Date('2026-11-09T02:00:00Z');
  it('UTC+8 → 本地 10:00，标注时区', () => {
    const line = timeContextLine(480, now);
    expect(line).toContain('2026-11-09 10:00');
    expect(line).toContain('UTC+08:00');
    expect(line).toContain('不要主动报时');
  });
  it('null 偏移回落 UTC+0', () => {
    const line = timeContextLine(null, now);
    expect(line).toContain('2026-11-09 02:00');
    expect(line).toContain('UTC+00:00');
  });
  it('负偏移（UTC-5）→ 前一日 21:00', () => {
    const line = timeContextLine(-300, now);
    expect(line).toContain('2026-11-08 21:00');
    expect(line).toContain('UTC-05:00');
  });
});