import { describe, expect, it } from 'vitest';
import {
  parseSummaryPoints,
  planSummary,
  SESSION_SUMMARY_MAX_POINTS,
  SESSION_SUMMARY_MAX_TEXT
} from '@/lib/cognitive/memory-session-summary';

/**
 * 会话结束总结的两块纯逻辑：
 * - 解析：模型输出必须带出处（merges 只能取片段 id），查重/改口的 id 只能取其它记忆 id；
 * - 计划：重复的不落库也不归档碎片、超上限的计入 rejected、归档清单由 merges 并集去重得出。
 */

const FRAGMENTS = new Set(['f-1', 'f-2', 'f-3']);
const OTHERS = new Set(['o-1', 'o-2']);

describe('parseSummaryPoints：防御性解析', () => {
  it('合法要点逐条收下', () => {
    const got = parseSummaryPoints(
      '[{"text":"我的长期目标是建立个人能力培养体系","type":"goal","merges":["f-1","f-2"]}]',
      { fragmentIds: FRAGMENTS, otherIds: OTHERS }
    );
    expect(got).toEqual([
      { text: '我的长期目标是建立个人能力培养体系', type: 'goal', merges: ['f-1', 'f-2'] }
    ]);
  });

  it('merges 里编造的 id 丢掉；全编造时整条丢弃（没有出处的要点不许落库）', () => {
    const got = parseSummaryPoints(
      '[{"text":"有效要点甲乙","type":"fact","merges":["f-1","f-999"]},{"text":"无出处要点丙丁","type":"fact","merges":["f-999"]}]',
      { fragmentIds: FRAGMENTS, otherIds: OTHERS }
    );
    expect(got).toEqual([{ text: '有效要点甲乙', type: 'fact', merges: ['f-1'] }]);
  });

  it('duplicateOf / updates 只认其它记忆的 id', () => {
    const got = parseSummaryPoints(
      '[{"text":"重复的说法甲乙","type":"fact","merges":["f-1"],"duplicateOf":"o-1"},{"text":"改口的说法丙丁","type":"fact","merges":["f-2"],"updates":"o-2"},{"text":"乱指的说法戊己","type":"fact","merges":["f-3"],"duplicateOf":"o-999"}]',
      { fragmentIds: FRAGMENTS, otherIds: OTHERS }
    );
    expect(got?.[0]).toMatchObject({ duplicateOf: 'o-1' });
    expect(got?.[1]).toMatchObject({ updates: 'o-2' });
    expect(got?.[2]?.duplicateOf).toBeUndefined();
  });

  it('同时标重复和更新时按重复处理（重复不落库，就没有取代这回事）', () => {
    const got = parseSummaryPoints(
      '[{"text":"既是重复又说改口","type":"fact","merges":["f-1"],"duplicateOf":"o-1","updates":"o-2"}]',
      { fragmentIds: FRAGMENTS, otherIds: OTHERS }
    );
    expect(got?.[0]?.duplicateOf).toBe('o-1');
    expect(got?.[0]?.updates).toBeUndefined();
  });

  it('非法 type、超长、空 merges、问句式空话都剔除', () => {
    const long = '数'.repeat(SESSION_SUMMARY_MAX_TEXT + 1);
    const got = parseSummaryPoints(
      `[{"text":"${long}","type":"goal","merges":["f-1"]},{"text":"类型不对条目","type":"unknown","merges":["f-1"]},{"text":"","type":"fact","merges":["f-1"]},{"text":"没有合并列表","type":"fact"}]`,
      { fragmentIds: FRAGMENTS, otherIds: OTHERS }
    );
    expect(got).toEqual([]);
  });

  it('解析不出数组返回 null（调用方不动库）', () => {
    expect(parseSummaryPoints('抱歉我无法总结', { fragmentIds: FRAGMENTS, otherIds: OTHERS })).toBeNull();
    expect(parseSummaryPoints('[broken', { fragmentIds: FRAGMENTS, otherIds: OTHERS })).toBeNull();
  });

  it('空数组是合法结论（这一场没有值得收拢的要点）', () => {
    expect(parseSummaryPoints('[]', { fragmentIds: FRAGMENTS, otherIds: OTHERS })).toEqual([]);
  });
});

describe('planSummary：重复并、超出上限、归档清单', () => {
  it('重复的不进 create，也不归档它的碎片（碎片是那条已有记忆的旁证）', () => {
    const plan = planSummary([
      { text: '重复的说法', type: 'fact', merges: ['f-1'], duplicateOf: 'o-1' },
      { text: '新要点', type: 'goal', merges: ['f-2', 'f-3'] }
    ]);
    expect(plan.create).toHaveLength(1);
    expect(plan.duplicates).toBe(1);
    expect(plan.archive).toEqual(['f-2', 'f-3']);
  });

  it('归档清单去重', () => {
    const plan = planSummary([
      { text: '要点一', type: 'fact', merges: ['f-1', 'f-2'] },
      { text: '要点二', type: 'fact', merges: ['f-2', 'f-3'] }
    ]);
    expect(plan.archive).toEqual(['f-1', 'f-2', 'f-3']);
  });

  it('超出条数上限的计入 rejected，不落库也不归档', () => {
    const points = Array.from({ length: SESSION_SUMMARY_MAX_POINTS + 2 }, (_, index) => ({
      text: `要点${index}`,
      type: 'fact' as const,
      merges: [`f-${index}`]
    }));
    const plan = planSummary(points);
    expect(plan.create).toHaveLength(SESSION_SUMMARY_MAX_POINTS);
    expect(plan.rejected).toBe(2);
  });
});
