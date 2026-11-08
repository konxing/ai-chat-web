import { describe, expect, it } from 'vitest';
import { decideQuestion } from '@/lib/cognitive/conversation/planning/question-budget';
import { understandDialogue } from '@/lib/cognitive/conversation/understanding/dialogue-act';
import { buildConversationState } from '@/lib/cognitive/conversation/state/conversation-state';
import { selectResponseAct } from '@/lib/cognitive/conversation/planning/response-act';

function decide(content: string, recent: Array<{ role: 'user' | 'assistant'; content: string }> = []) {
  const u = understandDialogue(content);
  const state = buildConversationState(recent, content, u);
  return decideQuestion({ content, understanding: u, state });
}

describe('B2 追问价值预算', () => {
  it('分享/倾诉：不强制追问', () => {
    const d = decide('今天总算把报告写完了。');
    expect(d.responseMove).toBe('CONTINUE_WITHOUT_QUESTION');
    expect(d.reasonCode).toBe('SHARING');
  });

  it('观点讨论：不把追问当完整回答的必要条件', () => {
    const d = decide('你觉得远程办公利大于弊吗？');
    expect(d.responseMove).toBe('CONTINUE_WITHOUT_QUESTION');
  });

  it('上轮已问未答：不重复索取（repeat_question_rate）', () => {
    const recent = [
      { role: 'user' as const, content: '就是那个问题。' },
      { role: 'assistant' as const, content: '你是指缓存问题吗？' }
    ];
    const d = decide('嗯，差不多。', recent);
    expect(d.reasonCode).toBe('ALREADY_KNOWN');
    expect(d.responseMove).not.toBe('ASK_ONE');
    expect(d.alreadyKnown.length).toBeGreaterThan(0);
  });

  it('确实缺关键事实（预订缺日期）：只问一个 ESSENTIAL', () => {
    const d = decide('帮我订一张去北京的票。');
    expect(d.responseMove).toBe('ASK_ONE');
    expect(d.reasonCode).toBe('ESSENTIAL');
    expect(d.essentialMissing).toContain('日期/时间');
    expect(d.expectedInformationGain).toBe('high');
  });

  it('关键信息已给出：不再索取', () => {
    const d = decide('帮我订一张明天去北京的票。');
    expect(d.responseMove).not.toBe('ASK_ONE');
    expect(d.alreadyKnown).toContain('日期/时间');
  });

  it('可安全默认的任务：直接完成并披露假设，不抢占回合', () => {
    const d = decide('帮我选一个方案，怎么选取决于场景。');
    expect(d.responseMove).toBe('ANSWER_NOW');
    expect(d.reasonCode).not.toBe('ESSENTIAL');
  });

  it('信息充分的任务：不追问', () => {
    const d = decide('为什么天空是蓝色的？');
    expect(d.responseMove).toBe('ANSWER_NOW');
    expect(d.reasonCode).toBe('LOW_VALUE');
  });

  it('纠错轮：先修复不追问', () => {
    const d = decide('不是这个意思，我只是想聊聊。');
    expect(d.responseMove).toBe('ANSWER_NOW');
  });
});

describe('B2 接入回应动作', () => {
  it('分享轮 primary 不是追问，且带 question 诊断', () => {
    const content = '今天一个 Bug 修了一天还没好。';
    const u = understandDialogue(content);
    const state = buildConversationState([], content, u);
    const act = selectResponseAct(u, state, content);
    expect(act.primary).toBe('ACKNOWLEDGE_AND_EXPLORE');
    expect(act.question?.reasonCode).toBe('SHARING');
  });

  it('非必要澄清被抑制为直接回答', () => {
    // 模糊但有上下文（topic 非空）→ 预算判 ANSWER_NOW，不应追问。
    const recent = [{ role: 'user' as const, content: '聊聊缓存。' }];
    const content = '嗯';
    const u = understandDialogue(content);
    const state = buildConversationState(recent, content, u);
    const act = selectResponseAct(u, state, content);
    expect(act.primary).not.toBe('ASK_ONE_CLARIFICATION');
  });
});