import { describe, expect, it } from 'vitest';
import { assessConfidence, type ConfidenceInput } from '@/lib/cognitive/confidence';
import type { MemoryOrigin } from '@/lib/cognitive/memories';

/**
 * 置信度评分（任务书 2.2）。
 *
 * 明令禁止的是「LLM 随口生成的数字」，所以这里是一个确定性纯函数，
 * 每一分都能说出是哪个因子给的——factors 就是那份说明书，界面直接拿它显示。
 *
 * 四个因子按任务书点名的四样来：来源可靠程度（origin 基线）、独立证据数量（重复陈述，
 * 有封顶）、冲突情况（反对证据，重罚且封档）、时间有效性（已过有效期直接归零）。
 *
 * 重复陈述的加分刻意封顶：说十遍不比说四遍更真，
 * 而 7.1 也写明「检索次数不能直接提高事实可信度」——被反复用到和被反复说过是两回事，
 * 这里只认后者，而且认得有限。
 */

const NOW = new Date('2026-11-03T12:00:00.000Z');

function input(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    origin: 'explicit',
    confirmedAt: '2026-11-01T10:00:00.000Z',
    supersededAt: null,
    validTo: null,
    supports: 1,
    contradicts: 0,
    now: NOW,
    ...overrides
  };
}

function origin(value: MemoryOrigin, overrides: Partial<ConfidenceInput> = {}) {
  return assessConfidence(input({ origin: value, ...overrides }));
}

describe('来源可靠程度决定基线', () => {
  it('用户亲口说过是 0.6，落在中档', () => {
    const result = origin('explicit');

    expect(result.score).toBeCloseTo(0.6, 5);
    expect(result.band).toBe('medium');
    expect(result.factors).toEqual([{ kind: 'origin', origin: 'explicit' }]);
  });

  it('用户亲手确认过更高，落在高档', () => {
    const result = origin('userConfirmed');

    expect(result.score).toBeCloseTo(0.8, 5);
    expect(result.band).toBe('high');
  });

  it('观察、推断、假设逐级降低，都在低档——推断永远不等于用户说过', () => {
    expect(origin('observed').score).toBeCloseTo(0.4, 5);
    expect(origin('inferred').score).toBeCloseTo(0.25, 5);
    expect(origin('hypothesis').score).toBeCloseTo(0.15, 5);
    for (const value of ['observed', 'inferred', 'hypothesis'] as MemoryOrigin[]) {
      expect(origin(value).band).toBe('low');
    }
  });

  it('非用户确认的来源，即使带确认时间也不给那 0.05', () => {
    expect(origin('observed').score).toBeCloseTo(0.4, 5);
  });
});

describe('独立证据数量，加分有封顶', () => {
  it('多一次独立陈述加 0.08，并把次数写进 factors', () => {
    const result = origin('explicit', { supports: 2 });

    expect(result.score).toBeCloseTo(0.68, 5);
    expect(result.factors).toContainEqual({ kind: 'restated', count: 1 });
  });

  it('三条独立陈述就封顶，说十遍不比说四遍更真', () => {
    const four = origin('explicit', { supports: 4 });
    const ten = origin('explicit', { supports: 10 });

    expect(four.score).toBeCloseTo(0.84, 5);
    expect(ten.score).toBeCloseTo(0.84, 5);
    expect(ten.factors).toContainEqual({ kind: 'restated', count: 9 });
  });

  it('创建记忆那一条支持证据是基线本身，不重复计分', () => {
    expect(origin('explicit', { supports: 1 }).factors).not.toContainEqual(
      expect.objectContaining({ kind: 'restated' })
    );
    expect(origin('explicit', { supports: 0 }).score).toBeCloseTo(0.6, 5);
  });
});

describe('冲突情况：有反对证据就重罚并封档', () => {
  it('一条反对证据扣 0.25', () => {
    expect(origin('explicit', { contradicts: 1 }).score).toBeCloseTo(0.35, 5);
  });

  it('分数够高也不许进中档：存在冲突的记忆最多只能是低档', () => {
    const result = origin('userConfirmed', { supports: 4, contradicts: 1 });

    // 0.75 基线 + 0.05 亲手确认 + 0.24 三次独立陈述 − 0.25 一条反对证据
    expect(result.score).toBeCloseTo(0.79, 5);
    expect(result.band).toBe('low');
    expect(result.factors).toContainEqual({ kind: 'contradicted', count: 1 });
  });

  it('分数不会变成负数', () => {
    const result = origin('explicit', { contradicts: 10 });

    expect(result.score).toBe(0);
    expect(result.band).toBe('low');
  });
});

describe('时间有效性与终态', () => {
  it('已过有效期的记忆归零，不再能当当前事实用', () => {
    const result = origin('explicit', { validTo: '2026-01-01T00:00:00.000Z' });

    expect(result.score).toBe(0);
    expect(result.band).toBe('low');
    expect(result.factors[0]).toEqual({ kind: 'expired' });
  });

  it('有效期还没到就不扣分', () => {
    expect(origin('explicit', { validTo: '2027-01-01T00:00:00.000Z' }).score).toBeCloseTo(0.6, 5);
  });

  it('恰好在这一刻失效算已过期', () => {
    expect(origin('explicit', { validTo: NOW.toISOString() }).band).toBe('low');
  });

  it('已撤回的记忆归零', () => {
    const result = origin('retracted');

    expect(result.score).toBe(0);
    expect(result.band).toBe('low');
    expect(result.factors[0]).toEqual({ kind: 'retracted' });
  });

  it('被新说法取代的旧版本压到 0.1，并且带着取代标记', () => {
    const result = origin('explicit', { supersededAt: '2026-11-02T00:00:00.000Z' });

    expect(result.score).toBeCloseTo(0.1, 5);
    expect(result.band).toBe('low');
    expect(result.factors[0]).toEqual({ kind: 'superseded' });
  });

  it('终态因子排在最前面：那是关于这条记忆最重要的事实', () => {
    const result = origin('explicit', {
      supersededAt: '2026-11-02T00:00:00.000Z',
      supports: 3,
      contradicts: 1
    });

    expect(result.factors.map((factor) => factor.kind)).toEqual([
      'superseded',
      'origin',
      'restated',
      'contradicted'
    ]);
  });
});

describe('档位边界', () => {
  it('0.75 及以上是高档，0.45 到 0.75 是中档，其余低档', () => {
    expect(origin('userConfirmed', { confirmedAt: null }).band).toBe('high');
    expect(origin('explicit').band).toBe('medium');
    expect(origin('observed').band).toBe('low');
    expect(origin('observed', { supports: 2 }).band).toBe('medium');
  });

  it('分数永远落在 0 到 1 之间', () => {
    for (const value of ['explicit', 'userConfirmed', 'observed', 'inferred', 'hypothesis', 'retracted'] as MemoryOrigin[]) {
      for (const supports of [0, 1, 5, 50]) {
        for (const contradicts of [0, 1, 5]) {
          const { score } = origin(value, { supports, contradicts });
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
