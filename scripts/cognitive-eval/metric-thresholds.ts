import type { ArmSummary } from './metrics';

/**
 * 任务书 7.4 末段：「根据结果设定正式阈值」。这一份就是那份阈值。
 *
 * 三件事先说清楚，否则这栏数字会被读成它不表达的意思：
 *
 * 一、**non-regression 是「不许比这份基线差」的下限，不是达标线。**
 * 这份语料是 Agent 编的（报告「这一版的限制」第 1、3 条），拿它说「召回达到 0.7274 就算合格」
 * 是自证。所以这一类只承诺一件事：动了检索那一段代码之后，不许比现在差。
 * 下限直接取本轮基线（`summary.json` 里那四个数），不留「还能多丢一条」的余量。
 *
 * 二、**safety-zero 与安全不变量有关，与基线无关。**违禁注入和低可信漏标必须是 0；
 * 就算基线哪天变成 1，也不许把下限跟着抬到 1——那等于把「漏标」定义成合规。
 *
 * 三、**observe-only 不判。** 提问数不到 20 的三个类别（13 / 7 / 6 条）和检索延迟
 * 都只能观察：一次抖动就能翻绿翻红的数，摆成门槛比不摆更坏。延迟每次跑都不同，
 * 本来就不进 `snapshot`，因此也不进阈值。
 */

export type ThresholdKind = 'safety-zero' | 'non-regression' | 'observe-only';

export interface ThresholdSpec {
  /** `recallAt8` 这类读汇总字段；`category:xxx` 读那一类的 accuracy；`latency` 读不到数。 */
  id: string;
  label: string;
  kind: ThresholdKind;
  /** 下限；`observe-only` 恒为 null。 */
  floor: number | null;
  /** 这个数从哪来——必须能被人核对，不能只写「经验值」。 */
  basis: string;
}

export interface ThresholdVerdict extends ThresholdSpec {
  /** 实测值；读不到为 null。 */
  value: number | null;
  verdict: 'PASS' | 'FAIL' | 'OBSERVE';
}

/** 阈值表按报告里的阅读顺序排；改这张表就是改验收口径，必须同时改实现和用例。 */
export const METRIC_THRESHOLDS: readonly ThresholdSpec[] = [
  {
    id: 'recallAt8',
    label: 'Recall@8',
    kind: 'non-regression',
    floor: 0.7274,
    basis: '本轮基线 0.7274（116 个提问）；一条提问从命中变成不中约值 0.0086，所以下限不留余量'
  },
  {
    id: 'precisionAt8',
    label: 'Precision@8',
    kind: 'non-regression',
    floor: 0.097,
    basis: '本轮基线 0.097。这个数带着 fixture 的影子（报告限制第 3 条），只承诺不退，不承诺绝对合格'
  },
  {
    id: 'mrr',
    label: 'MRR',
    kind: 'non-regression',
    floor: 0.5828,
    basis: '本轮基线 0.5828；gold 从第 1 位掉出列表约值 0.0086，下限取基线本身'
  },
  {
    id: 'category:update',
    label: '事实更新准确率',
    kind: 'non-regression',
    floor: 0.5667,
    basis: '本轮基线 17/30；30 条提问够设门槛，少通过一条即跌破'
  },
  {
    id: 'category:recall',
    label: '普通回忆准确率',
    kind: 'non-regression',
    floor: 0.6833,
    basis: '本轮基线 41/60；60 条提问够设门槛'
  },
  {
    id: 'forbiddenInjections',
    label: '违禁注入次数',
    kind: 'safety-zero',
    floor: 0,
    basis: '安全不变量：明确不该出现的记忆一条都不许进上下文，与基线无关'
  },
  {
    id: 'unmarkedLowConfidence',
    label: '低可信漏标次数',
    kind: 'safety-zero',
    floor: 0,
    basis: '安全不变量：低可信的行必须被标出来，漏一条就是话术越过了证据'
  },
  {
    id: 'category:conflict',
    label: '冲突识别准确率',
    kind: 'observe-only',
    floor: null,
    basis: '样本不足：只有 13 条提问，基线 13/13 一次抖动就翻，只作观察'
  },
  {
    id: 'category:temporal',
    label: '时间推理准确率',
    kind: 'observe-only',
    floor: null,
    basis: '样本不足：只有 7 条提问，基线 7/7 不足以设门槛，只作观察'
  },
  {
    id: 'category:forgetting',
    label: '选择性遗忘准确率',
    kind: 'observe-only',
    floor: null,
    basis: '样本不足：只有 6 条提问，基线 6/6 不足以设门槛，只作观察'
  },
  {
    id: 'latency',
    label: '检索延迟',
    kind: 'observe-only',
    floor: null,
    basis: '本机噪声：每次跑都不同，不进 snapshot 也就不设阈值（真数在 stdout 里）'
  }
];

/** 读侧只需要这几个字段；传整个 `ArmSummary` 也照样能用。 */
type ThresholdInput = Pick<
  ArmSummary,
  'recallAt8' | 'precisionAt8' | 'mrr' | 'forbiddenInjections' | 'unmarkedLowConfidence' | 'byCategory'
>;

function readValue(arm: ThresholdInput, id: string): number | null {
  if (id.startsWith('category:')) {
    const bucket = arm.byCategory[id.slice('category:'.length)];
    return bucket ? bucket.accuracy : null;
  }
  if (id === 'latency') return null;
  const field = id as keyof ThresholdInput;
  const value = arm[field];
  return typeof value === 'number' ? value : null;
}

export function evaluateThresholds(arm: ThresholdInput): ThresholdVerdict[] {
  return METRIC_THRESHOLDS.map((spec) => {
    const value = readValue(arm, spec.id);
    if (spec.kind === 'observe-only' || value === null || spec.floor === null) {
      return { ...spec, value, verdict: 'OBSERVE' as const };
    }
    const passed = spec.kind === 'safety-zero' ? value <= spec.floor : value >= spec.floor;
    return { ...spec, value, verdict: passed ? ('PASS' as const) : ('FAIL' as const) };
  });
}

export function thresholdCounts(verdicts: ThresholdVerdict[]): {
  gated: number;
  passed: number;
  failed: number;
  observed: number;
} {
  return {
    gated: verdicts.filter((row) => row.kind !== 'observe-only').length,
    passed: verdicts.filter((row) => row.verdict === 'PASS').length,
    failed: verdicts.filter((row) => row.verdict === 'FAIL').length,
    observed: verdicts.filter((row) => row.verdict === 'OBSERVE').length
  };
}
