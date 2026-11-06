import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  METRIC_THRESHOLDS,
  evaluateThresholds,
  thresholdCounts
} from '../../scripts/cognitive-eval/metric-thresholds';
import { renderReport, renderSummary } from '../../scripts/cognitive-eval/report';

/**
 * 任务书 7.4 末段要的「根据结果设定正式阈值」。
 *
 * 这一片最容易做错的地方是：阈值一写成「基线等于多少就设多少」，它就永远为真，
 * 于是报告里多了一栏绿灯，实际什么也没守。所以下面每一条都在检查
 * **阈值是不是从基线推出来的、而且比基线严**——不是「有没有一行 PASS」。
 *
 * 三类阈值的语义不一样，不许混：
 * - safety-zero：安全不变量，必须是 0，与基线无关（违禁注入、低可信漏标）。
 * - non-regression：从基线减掉一个能说出是几条提问的容差；它是「不许退回去」的下限，**不是达标线**。
 * - observe-only：样本不足或本机噪声，明说不判。摆一个假的门槛比不摆更坏。
 */

const summary = JSON.parse(
  readFileSync(join(__dirname, '../../scripts/cognitive-eval/summary.json'), 'utf8')
);

describe('阈值表本身', () => {
  it('每条都有语义、依据；safety-zero 的下限必须是 0，observe-only 必须没有下限', () => {
    expect(METRIC_THRESHOLDS.length).toBeGreaterThan(0);
    for (const row of METRIC_THRESHOLDS) {
      expect(['safety-zero', 'non-regression', 'observe-only']).toContain(row.kind);
      expect(row.basis.length).toBeGreaterThan(10);
      if (row.kind === 'safety-zero') expect(row.floor).toBe(0);
      if (row.kind === 'observe-only') expect(row.floor).toBeNull();
      if (row.kind === 'non-regression') expect(row.floor).not.toBeNull();
    }
  });

  it('116 条提问的语料下，只有提问数够的类别才设门槛，其余只能观察', () => {
    const gated = METRIC_THRESHOLDS.filter((row) => row.kind !== 'observe-only').map((row) => row.id);
    const observed = METRIC_THRESHOLDS.filter((row) => row.kind === 'observe-only').map((row) => row.id);
    // 提问数 <20 的三个类别不许进门槛表：13/7/6 条样本上一次抖动就能翻绿翻红。
    expect(gated).not.toContain('category:conflict');
    expect(gated).not.toContain('category:temporal');
    expect(gated).not.toContain('category:forgetting');
    expect(observed).toEqual(
      expect.arrayContaining(['category:conflict', 'category:temporal', 'category:forgetting', 'latency'])
    );
  });

  it('延迟不进 snapshot，所以也不许被设成一个阈值', () => {
    const latency = METRIC_THRESHOLDS.find((row) => row.id === 'latency');
    expect(latency?.kind).toBe('observe-only');
    expect(latency?.floor).toBeNull();
  });
});

describe('用真基线跑一遍', () => {
  const verdicts = evaluateThresholds(summary.arms.current);

  it('有门槛的项当前全部通过，且一项都没被设成永远为真的数', () => {
    const counts = thresholdCounts(verdicts);
    expect(counts.failed).toBe(0);
    expect(counts.gated).toBe(counts.passed + counts.failed);
    expect(counts.gated).toBeGreaterThanOrEqual(7);
  });

  it('每条 non-regression 的下限不许比基线松出 5 个百分点——挡的是「设一个永远为真的低数」', () => {
    for (const row of verdicts) {
      if (row.kind !== 'non-regression' || row.value === null) continue;
      expect(row.floor as number).toBeLessThanOrEqual(row.value);
      expect(row.value - (row.floor as number)).toBeLessThanOrEqual(0.05);
    }
  });

  it('没门槛的那几条被诚实标成 OBSERVE，而不是被算进通过率', () => {
    const counts = thresholdCounts(verdicts);
    expect(counts.observed).toBe(4);
    for (const row of verdicts.filter((item) => item.kind === 'observe-only')) {
      expect(row.verdict).toBe('OBSERVE');
    }
  });
});

describe('回退必须判退', () => {
  /** 从真基线出发只改一个数，别的都保持原样——变异才看得出是哪一栏在守。 */
  function armWith(patch: Record<string, unknown>) {
    return { ...summary.arms.current, ...patch };
  }

  it('Recall@8 退到下限以下：判退', () => {
    const verdicts = evaluateThresholds(armWith({ recallAt8: 0.69 }) as never);
    expect(verdicts.find((row) => row.id === 'recallAt8')?.verdict).toBe('FAIL');
  });

  it('违禁注入从 0 变成 1：安全不变量那条判退，而且不靠任何基线', () => {
    const verdicts = evaluateThresholds(armWith({ forbiddenInjections: 1 }) as never);
    const row = verdicts.find((item) => item.id === 'forbiddenInjections');
    expect(row?.verdict).toBe('FAIL');
    expect(row?.kind).toBe('safety-zero');
  });

  it('低可信漏标出现一条：判退', () => {
    const verdicts = evaluateThresholds(armWith({ unmarkedLowConfidence: 1 }) as never);
    expect(verdicts.find((row) => row.id === 'unmarkedLowConfidence')?.verdict).toBe('FAIL');
  });

  it('事实更新少通过一条就判退：下限就是这份基线，没有留「可以多丢一条」的余量', () => {
    const baseline = summary.arms.current.byCategory.update.accuracy as number;
    const oneLess = (17 - 1) / 30;
    expect(oneLess).toBeLessThan(baseline);
    const verdicts = evaluateThresholds(
      armWith({
        byCategory: {
          ...summary.arms.current.byCategory,
          update: { ...summary.arms.current.byCategory.update, accuracy: oneLess }
        }
      }) as never
    );
    expect(verdicts.find((row) => row.id === 'category:update')?.verdict).toBe('FAIL');
  });

  it('数值读不到的项（延迟）不许被判成通过', () => {
    const verdicts = evaluateThresholds(armWith({}) as never);
    const latency = verdicts.find((row) => row.id === 'latency');
    expect(latency?.value).toBeNull();
    expect(latency?.verdict).toBe('OBSERVE');
    // 观察项一律不进 gated：它既不算通过也不算失败。
    expect(thresholdCounts(verdicts).gated).toBe(verdicts.filter((row) => row.kind !== 'observe-only').length);
  });
});

describe('报告里的说法', () => {
  const report = renderReport({
    scores: summary.scores,
    arms: summary.arms,
    visibleSize: summary.counts.visibleMemories,
    poolSize: 200,
    dilution: summary.dilution
  });

  it('写清了这是「非回归下限」而不是达标线，也写清了延迟不设阈值', () => {
    expect(report).toContain('非回归下限');
    expect(report).toContain('不是达标线');
    expect(report).toContain('样本不足');
  });

  it('29 项账本仍然全在，阈值这一节是加上去的、不是把账本换掉', () => {
    expect(report).toContain('7.3 指标账本');
    expect(report).toContain('7.4 阈值');
  });
});

describe('summary.json 里的阈值要机器可读', () => {
  const summaryText = renderSummary({
    scores: summary.scores,
    arms: summary.arms,
    visibleSize: summary.counts.visibleMemories,
    poolSize: 200,
    dilution: summary.dilution
  });
  const payload = JSON.parse(summaryText);

  it('failed / gated / observed 三个数和逐行判定一起进 payload', () => {
    expect(payload.thresholds.failed).toBe(0);
    expect(payload.thresholds.gated).toBe(7);
    expect(payload.thresholds.observed).toBe(4);
    expect(payload.thresholds.rows).toHaveLength(11);
    expect(payload.thresholds.rows.find((row: { id: string }) => row.id === 'recallAt8').floor).toBe(0.7274);
  });
});
