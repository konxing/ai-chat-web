import { describe, expect, it } from 'vitest';
import { matchOutcomes } from '@/lib/cognitive/outcome-extractor';

const decisions = [
  { id: 'd1', topic: '用 PostgreSQL，不上 MySQL 了' },
  { id: 'd2', topic: '买一台二手笔记本，预算六千' }
];

/**
 * 任务书 5.3：用户后续主动提及结果时，可以关联到原决策。
 * 词法 v1 的两道闸：结果标记（结果/后来/最终…）+ 与决策主题至少一个共同词。
 * 没有共同词就不连——把「结果项目黄了」连到买笔记本上，比不连更坏。
 * 连出来的也只是候选（CANDIDATE），确认在界面上做，这里不替用户归因。
 */
describe('结果陈述与决策的候选匹配', () => {
  it('有结果标记且和主题有共同词才连', () => {
    const got = matchOutcomes('结果 PostgreSQL 跑了一个月，比想象中稳。', decisions);
    expect(got).toEqual([
      {
        decisionId: 'd1',
        actual: '结果 PostgreSQL 跑了一个月，比想象中稳',
        gap: null,
        rating: null,
        missedFactors: null,
        lesson: null
      }
    ]);
  });

  it('中文主题靠共同 bigram 连上', () => {
    const got = matchOutcomes('后来那台笔记本电池不行，退换了一次。', decisions);
    expect(got.map((match) => match.decisionId)).toEqual(['d2']);
  });

  it('有标记但没有共同词：不连', () => {
    expect(matchOutcomes('结果今天下雨了，没去成。', decisions)).toHaveLength(0);
  });

  it('有共同词但没有结果标记：不连', () => {
    expect(matchOutcomes('PostgreSQL 的版本是 17。', decisions)).toHaveLength(0);
  });

  it('问句不算结果陈述', () => {
    expect(matchOutcomes('后来 PostgreSQL 还稳吗？', decisions)).toHaveLength(0);
  });

  it('一轮最多两条候选链接', () => {
    const got = matchOutcomes(
      '结果 PostgreSQL 很稳。后来那台笔记本也到货了。',
      decisions
    );
    expect(got).toHaveLength(2);
  });

  it('一句话里的评价、遗漏、经验各归一列，取的都是原话里的那半句', () => {
    const got = matchOutcomes(
      '结果 PostgreSQL 跑了一个月，真香，没想到备份这么麻烦，下次一定先估运维成本。',
      decisions
    );
    expect(got).toEqual([
      {
        decisionId: 'd1',
        actual: '结果 PostgreSQL 跑了一个月，真香，没想到备份这么麻烦，下次一定先估运维成本',
        gap: null,
        rating: '真香',
        missedFactors: '没想到备份这么麻烦',
        lesson: '下次一定先估运维成本'
      }
    ]);
  });

  it('同一个分句只进一列：先撞上哪个标记算哪个，不重复登记', () => {
    const got = matchOutcomes('结果 PostgreSQL 没想到下次还要这样。', decisions);
    expect(got[0]).toMatchObject({
      missedFactors: '结果 PostgreSQL 没想到下次还要这样',
      lesson: null
    });
  });

  it('一个决策一轮只出一条：库里 (sourceMessageId, decisionId) 是唯一的，多出的那句会被静默丢掉', () => {
    const got = matchOutcomes(
      '结果 PostgreSQL 很稳。后来 PostgreSQL 踩了坑，本来以为不用管备份。',
      decisions
    );
    expect(got).toHaveLength(1);
    // 第一句留下 actual，第二句里的分面合并进同一条——不然那句话就消失了。
    expect(got[0]!.actual).toBe('结果 PostgreSQL 很稳');
    expect(got[0]!.rating).toBe('后来 PostgreSQL 踩了坑');
    expect(got[0]!.gap).toBe('本来以为不用管备份');
  });

  it('同一分面只留第一次撞上的分句，后面那句不覆盖', () => {
    const got = matchOutcomes('结果 PostgreSQL 很稳，真香，用下来也挺靠谱。', decisions);
    expect(got[0]!.rating).toBe('真香');
  });

  it('名额给两条决策用完后，第三条决策不立，但已有那条还能续上分面', () => {
    const got = matchOutcomes(
      '结果 PostgreSQL 很稳。后来那台笔记本也到货了。最后阳台改成书房了。' +
        '实际上 PostgreSQL 挺靠谱，本来以为不用管备份。',
      [...decisions, { id: 'd3', topic: '把阳台改成书房' }]
    );
    expect(got.map((match) => match.decisionId)).toEqual(['d1', 'd2']);
    expect(got[0]!.rating).toBe('实际上 PostgreSQL 挺靠谱');
    expect(got[0]!.gap).toBe('本来以为不用管备份');
  });

  it('没有决策可连时返回空', () => {
    expect(matchOutcomes('结果 PostgreSQL 很稳。', [])).toHaveLength(0);
  });
});
