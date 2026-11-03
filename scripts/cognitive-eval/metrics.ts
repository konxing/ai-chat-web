import type { ProbeResult } from './harness';

/**
 * 7.3 的指标里，今天真能算的那几项。
 *
 * 每一条都写清楚它是**谁**守住的：seam 表示走的是 selectMemoryCandidates / renderMemoryBlock
 * 这段线上代码，mirror 表示靠的是 harness 里那份 visibleAt 复刻（真实来源是 listMemories 的
 * SQL 条件，另有测试守着）。把两类混在一个总分里报出去，就是拿复刻的数字冒充线上行为。
 */

export type Guard = 'seam' | 'mirror';

export interface ProbeScore {
  id: string;
  story: string;
  category: ProbeResult['probe']['category'];
  guard: Guard;
  arm: 'A2' | 'current';
  gold: string[];
  injected: string[];
  hits: string[];
  violations: string[];
  recall: number | null;
  precision: number;
  reciprocalRank: number;
  /** 要求低可信标注的那些条，有没有真的带上标注。 */
  missingLowMark: string[];
  injectedChars: number;
}

const LOW_MARK = /（可信度低[^）]*）/g;

/** 每个类别由哪一层守住——分类别报告时不许含糊。 */
const GUARD_BY_CATEGORY: Record<ProbeResult['probe']['category'], Guard> = {
  recall: 'seam',
  conflict: 'seam',
  forgetting: 'seam',
  update: 'mirror',
  temporal: 'mirror'
};

export function scoreProbe(result: ProbeResult): ProbeScore {
  const { probe, arm, injected, text, bands } = result;
  const gold = probe.gold;
  const hits = gold.filter((id) => injected.includes(id));
  const violations = (probe.forbidden ?? []).filter((id) => injected.includes(id));
  const firstHit = injected.findIndex((id) => gold.includes(id));
  const marks = text.match(LOW_MARK) ?? [];
  const missingLowMark = (probe.expectLowMarked ?? []).filter(
    (id) => injected.includes(id) && (bands[id] !== 'low' || marks.length === 0)
  );

  return {
    id: probe.id,
    story: probe.id.split('-')[0]!,
    category: probe.category,
    guard: GUARD_BY_CATEGORY[probe.category],
    arm,
    gold,
    injected,
    hits,
    violations,
    recall: gold.length === 0 ? null : hits.length / gold.length,
    precision: injected.length === 0 ? 0 : hits.length / injected.length,
    reciprocalRank: firstHit < 0 ? 0 : 1 / (firstHit + 1),
    missingLowMark,
    injectedChars: text.length
  };
}

export interface ArmSummary {
  probes: number;
  recallAt8: number;
  precisionAt8: number;
  mrr: number;
  /** 至少命中一条标准答案的提问占比。 */
  hitRate: number;
  /** 明确不该出现的记忆，被注入的总次数。 */
  forbiddenInjections: number;
  /** 按类别的通过率：标准答案全中，且没有违禁项。 */
  byCategory: Record<string, { probes: number; passed: number; accuracy: number; guard: Guard }>;
  /** 低可信标注缺失的次数（该标的没标）。 */
  unmarkedLowConfidence: number;
  avgInjectedChars: number;
  /** 每轮 8 个名额里平均有几条不是这一问该答的——补位噪声的直接读数。 */
  avgNonGoldSlots: number;
  /** 一次都没被捞回来的标准答案条数——这就是「关键词召回捞不到」的第一手依据。 */
  unreachableGold: string[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 保留四位小数：报告里读的是相对差异，多出来的位数只会让 snapshot 更容易被顺手改动。 */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * 「这一问算通过吗」按类别各自的语义来判，不用一个公式套所有类别：
 * 7.3 把它们列成不同指标，正是因为它们问的是不同的事——
 * 用同一个公式就会把「没捞到」记成「时间判断错了」，那个数字没法解释。
 */
function passes(score: ProbeScore): boolean {
  switch (score.category) {
    // 事实更新：既要说中最新版本，也不能把旧版本端出来。
    case 'update':
      return score.recall === 1 && score.violations.length === 0;
    // 时间推理与遗忘：只问「不该出现的那条出现了没有」。
    case 'temporal':
    case 'forgetting':
      return score.violations.length === 0;
    // 冲突识别：该带低可信标注的那条，出现了就必须带着标注。
    case 'conflict':
      return score.missingLowMark.length === 0;
    case 'recall':
      return score.recall === 1;
  }
}

export function summarizeArm(scores: readonly ProbeScore[]): ArmSummary {
  const withGold = scores.filter((score) => score.recall !== null);
  const byCategory: ArmSummary['byCategory'] = {};
  for (const score of scores) {
    const bucket = (byCategory[score.category] ??= {
      probes: 0,
      passed: 0,
      accuracy: 0,
      guard: score.guard
    });
    bucket.probes += 1;
    if (passes(score)) bucket.passed += 1;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.accuracy = bucket.probes === 0 ? 0 : round(bucket.passed / bucket.probes);
  }

  const unreachableGold = new Set<string>();
  for (const score of scores) {
    for (const id of score.gold) {
      if (!score.hits.includes(id)) unreachableGold.add(id);
    }
  }

  return {
    probes: scores.length,
    recallAt8: round(mean(withGold.map((score) => score.recall!))),
    precisionAt8: round(mean(scores.map((score) => score.precision))),
    mrr: round(mean(scores.map((score) => score.reciprocalRank))),
    hitRate: round(mean(withGold.map((score) => (score.hits.length > 0 ? 1 : 0)))),
    forbiddenInjections: scores.reduce((sum, score) => sum + score.violations.length, 0),
    byCategory,
    unmarkedLowConfidence: scores.reduce((sum, score) => sum + score.missingLowMark.length, 0),
    avgInjectedChars: round(mean(scores.map((score) => score.injectedChars))),
    avgNonGoldSlots: round(mean(scores.map((score) => score.injected.length - score.hits.length))),
    unreachableGold: [...unreachableGold].sort()
  };
}
