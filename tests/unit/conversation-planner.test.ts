import { describe, expect, it } from 'vitest';
import { planResponse } from '@/lib/cognitive/conversation/planning/response-planner';
import { DEFAULT_CONVERSATION_STYLE } from '@/lib/cognitive/conversation/core/conversation-policy';

const style = DEFAULT_CONVERSATION_STYLE;

describe('planResponse：轻量策略规划，不额外调用模型', () => {
  it('简单问句 → 直接回答，短长度', () => {
    const plan = planResponse({ mode: 'NATURAL_CHAT', content: '今天星期几？', style, hasPersonalMemory: false });
    expect(plan.strategies).toContain('DIRECT_ANSWER');
    expect(plan.responseLength).toBe('short');
  });

  it('教学模式 → 解释，复杂时深入', () => {
    const plan = planResponse({ mode: 'TUTOR', content: '教我理解傅里叶变换，为什么要把信号拆成正弦波？', style, hasPersonalMemory: false });
    expect(plan.strategies).toContain('EXPLAIN');
    expect(plan.strategies).toContain('DEEPEN');
  });

  it('用户错误假设 → 挑战（思维伙伴）', () => {
    const plan = planResponse({ mode: 'THINKING_PARTNER', content: '我觉得只要努力就一定能成功，所有人都这样', style, hasPersonalMemory: false });
    expect(plan.strategies).toContain('CHALLENGE');
  });

  it('情绪模式不强行分析/给方案', () => {
    const plan = planResponse({ mode: 'EMOTIONAL', content: '最近压力好大，心里很烦', style, hasPersonalMemory: false });
    expect(plan.strategies).toEqual(['CONTINUE']);
    expect(plan.strategies).not.toContain('DEEPEN');
    expect(plan.strategies).not.toContain('CHALLENGE');
  });

  it('模糊短消息 → 澄清', () => {
    const plan = planResponse({ mode: 'NATURAL_CHAT', content: '那个事情', style, hasPersonalMemory: false });
    expect(plan.clarificationRequired).toBe(true);
  });

  it('有个人记忆且用户提及历史 → 联系', () => {
    const plan = planResponse({ mode: 'NATURAL_CHAT', content: '我之前说的那个项目继续怎么做？', style, hasPersonalMemory: true });
    expect(plan.strategies).toContain('CONNECT');
  });

  it('planText 是内部提示，包含策略说明', () => {
    const plan = planResponse({ mode: 'TECHNICAL_EXPERT', content: '解释内核中断机制', style, hasPersonalMemory: false });
    expect(plan.planText).toContain('回答策略');
    expect(plan.planText).toContain('解释');
  });
});
