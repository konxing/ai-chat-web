import { describe, expect, it } from 'vitest';
import {
  DECISION_CANDIDATES_PER_TURN,
  extractDecisionCandidates
} from '@/lib/cognitive/decision-extractor';

/**
 * 任务书 5.1 的第一道闸：普通聊天里的每个选择都不能算重要决策。
 * 所以这里的负例和正例一样重要——抽多了比抽少了更坏，
 * 因为它会把「我中午吃面」变成一条要用户确认的正式决策候选。
 */
describe('决策候选抽取（词法 v1）', () => {
  it('六类各认自己的标记', () => {
    const cases: Array<[string, string]> = [
      ['我决定用 PostgreSQL，不上 MySQL 了。', 'TECH_CHOICE'],
      ['我准备启动一个副业项目，先做三个月试试。', 'PROJECT_PLANNING'],
      ['我打算跳槽去一家做基础设施的公司。', 'CAREER'],
      ['我计划考软考，明年上半年报。', 'LEARNING'],
      ['我打算买一台二手笔记本，预算六千。', 'PURCHASE'],
      ['我的目标是年底前把体脂降到 20%。', 'PERSONAL_GOAL']
    ];
    for (const [text, category] of cases) {
      const got = extractDecisionCandidates(text);
      expect(got, text).toHaveLength(1);
      expect(got[0]!.category).toBe(category);
    }
  });

  it('选择内容是标记之后的部分，主题不编造', () => {
    const [candidate] = extractDecisionCandidates('我决定用 PostgreSQL，不上 MySQL 了。');
    expect(candidate!.choice).toBe('用 PostgreSQL，不上 MySQL 了');
    expect(candidate!.topic).toBe('用 PostgreSQL，不上 MySQL 了');
  });

  it('问句、偏好和闲聊都不抽', () => {
    for (const text of [
      '我中午吃什么呢？',
      '我喜欢游泳，每周三次。',
      '今天天气不错，路上很顺。',
      '你觉得我该买哪个？'
    ]) {
      expect(extractDecisionCandidates(text), text).toHaveLength(0);
    }
  });

  it('一句话只算一类，按类别表顺序', () => {
    const got = extractDecisionCandidates('我决定买一台机器来跑我的学习目标。');
    expect(got).toHaveLength(1);
  });

  it('一轮最多两条候选', () => {
    const text = '我决定用 Rust 重写网关。我打算买一台新服务器。我计划考 CKA。';
    expect(extractDecisionCandidates(text)).toHaveLength(DECISION_CANDIDATES_PER_TURN);
  });

  it('太短的不抽', () => {
    expect(extractDecisionCandidates('我买了。')).toHaveLength(0);
  });
});

/**
 * 任务书 5.2 的「预期结果」和「可选的后续复盘时间」两列此前没有任何生产者。
 * 这组用例钉的是：能认领的唯一来源是**同一句话里用户自己说出来的那一段**。
 */
describe('预期结果与复盘时间：只认同一句里的原话', () => {
  it('同一句里的预期分句进 expectedOutcome，主题和选择不许被动过', () => {
    const [candidate] = extractDecisionCandidates('我决定用 PostgreSQL，预计查询能快一倍。');
    expect(candidate!.topic).toBe('用 PostgreSQL');
    expect(candidate!.expectedOutcome).toBe('预计查询能快一倍');
  });

  it('跨句不认领：下一句的希望在没提到决策的那句里，不替他拼成一件事', () => {
    const [candidate] = extractDecisionCandidates('我决定买这块显卡。我希望能用三年。');
    expect(candidate!.expectedOutcome).toBeNull();
  });

  it('没说预期就是 null，不许从「我决定」里推断出一个预期', () => {
    const [candidate] = extractDecisionCandidates('我打算学 Rust，每周投入十小时。');
    expect(candidate!.expectedOutcome).toBeNull();
  });

  it('一句里两个预期分句取第一个：第二个是补充，登记两遍就是把一句话说成两件事', () => {
    const [candidate] = extractDecisionCandidates('我改用 ClickHouse，预计查询快一倍，希望能省下运维时间。');
    expect(candidate!.expectedOutcome).toBe('预计查询快一倍');
  });

  it('「预计三个月后再看」是复盘时间，不是预期结果：同一句不许既是安排又是结果', () => {
    const [candidate] = extractDecisionCandidates('我决定用 PostgreSQL，预计三个月后再看一次。');
    expect(candidate!.expectedOutcome).toBeNull();
    expect(candidate!.sourceSentence).toContain('预计三个月后再看一次');
  });

  it('sourceSentence 是这一句的原话，句尾标点剥掉，其余不动', () => {
    const [candidate] = extractDecisionCandidates('我计划考软考，明年上半年报。');
    expect(candidate!.sourceSentence).toBe('我计划考软考，明年上半年报');
  });

  it('候选抽取不出来时，预期和复盘也不许单独立一条决策', () => {
    expect(extractDecisionCandidates('我希望能早点下班。')).toHaveLength(0);
  });
});
