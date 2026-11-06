import { describe, expect, it } from 'vitest';
import { METRIC_COVERAGE, coverageCounts } from '../../scripts/cognitive-eval/metric-coverage';
import { evaluate } from '../../scripts/cognitive-eval/evaluate';
import { renderReport, renderSummary } from '../../scripts/cognitive-eval/report';

/**
 * 任务书 7.3 的指标账本。
 *
 * 这一份要解决的问题不是「再多算几个数」，而是「哪些数有、哪些没有」今天只散在报告的一段散文里，
 * 而那段散文已经过期过两次（Phase 4/5/6 都写成了「未开始」，实际早已落地）。
 * 账本把 29 项逐条登记成机器可查的条目：要么指向真数，要么写明为什么没有、什么条件下才有。
 *
 * 任何一项从 blocked 变成 computed，都必须同时改实现和这里的期望值——
 * 不允许只把文案改成「已覆盖」。
 */

/** 7.3 原文逐条：顺序与任务书一致，改这个数组等于改验收口径。 */
const TASK_BOOK_METRICS = [
  'Recall@K',
  'Precision@K',
  'MRR',
  '事实更新准确率',
  '时间推理准确率',
  '冲突识别准确率',
  '选择性遗忘准确率',
  '关系分类准确率',
  '高置信度关系 Precision',
  '图扩展召回率',
  '无关关联比例',
  '事件提取准确率',
  '日期解析准确率',
  '目标状态转换准确率',
  '时间精度保留率',
  '证据覆盖率',
  '反例召回率',
  '无依据洞察比例',
  '重复洞察比例',
  '用户反馈后的修正准确率',
  '决策提取准确率',
  '决策结果匹配准确率',
  '相似决策召回率',
  '跨会话经验使用成功率',
  '检索延迟',
  '后台任务延迟',
  '模型 Token 消耗',
  '每轮额外模型调用次数',
  '数据库存储增长'
] as const;

/** 今天真有数的：记忆七项（分类别通过率 + 三个排序指标）+ 检索延迟。 */
const COMPUTED_TODAY = new Set<string>([
  'Recall@K',
  'Precision@K',
  'MRR',
  '事实更新准确率',
  '时间推理准确率',
  '冲突识别准确率',
  '选择性遗忘准确率',
  '检索延迟'
]);

describe('7.3 指标账本', () => {
  it('任务书的 29 项逐条在内，不重不漏', () => {
    expect(METRIC_COVERAGE.map((entry) => entry.name)).toEqual([...TASK_BOOK_METRICS]);
    expect(new Set(METRIC_COVERAGE.map((entry) => entry.name)).size).toBe(TASK_BOOK_METRICS.length);
  });

  it('每项都有组别和一句可复核的依据', () => {
    for (const entry of METRIC_COVERAGE) {
      expect(entry.group, entry.name).toMatch(/记忆|图关联|认知时间线|主动反思|决策记忆|系统/);
      expect(entry.detail.trim().length, entry.name).toBeGreaterThan(0);
      if (entry.status === 'blocked') {
        expect(entry.unblock?.trim().length ?? 0, entry.name).toBeGreaterThan(0);
      } else {
        expect(entry.unblock, entry.name).toBeUndefined();
      }
    }
  });

  it('「有数」的集合只有今天这八项，多一项都要先有实现', () => {
    const computed = new Set(METRIC_COVERAGE.filter((entry) => entry.status === 'computed').map((e) => e.name));
    expect(computed).toEqual(COMPUTED_TODAY);
  });

  it('计数与报告里写的一致', () => {
    expect(coverageCounts()).toEqual({ total: 29, computed: 8, blocked: 21 });
    const summary = JSON.parse(renderSummary(evaluate())) as {
      metricsCoverage: { total: number; computed: number; blocked: number };
    };
    expect(summary.metricsCoverage).toEqual({ total: 29, computed: 8, blocked: 21 });
  });

  it('报告把 29 项全列出来，并且不再出现「Phase X 未开始」这种过期原因', () => {
    const report = renderReport(evaluate());
    for (const name of TASK_BOOK_METRICS) {
      expect(report, name).toContain(name);
    }
    expect(report).not.toContain('Phase 4 认知时间线未开始');
    expect(report).not.toContain('Phase 6 未开始');
    expect(report).not.toContain('Phase 5 未开始');
  });
});