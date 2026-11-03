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
