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
    expect(d.essentialMissing).toContain('日期');
    expect(d.expectedInformationGain).toBe('high');
  });

  it('关键信息已给出：不再索取', () => {
    const d = decide('帮我订一张明天去北京的票。');
    expect(d.responseMove).not.toBe('ASK_ONE');
    expect(d.alreadyKnown).toContain('日期');
  });

  it('承接上文的购票请求沿用日期，另订不同目的地时不沿用', () => {
    const recent = [
      { role: 'user' as const, content: '我明天从上海出发去北京，上午出发就行。' },
      { role: 'assistant' as const, content: '知道了。' }
    ];
    const sameTrip = decide('帮我订一张高铁票。', recent);
    expect(sameTrip.responseMove).toBe('ANSWER_NOW');
    expect(sameTrip.alreadyKnown).toContain('日期');
    expect(decide('帮我订去南京的票。', recent).responseMove).toBe('ASK_ONE');
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
    expect(decide('预订火车票要注意什么？').responseMove).toBe('ANSWER_NOW');
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
    expect(act.contextNote).toContain('不用问题或邀请来收尾');
  });

  it('即使识别成建议请求，缺日期的预订也只澄清日期', () => {
    const content = '帮我订一张去北京的票，你建议怎么办？';
    const u = understandDialogue(content);
    const act = selectResponseAct(u, buildConversationState([], content, u), content);
    expect(act.primary).toBe('ASK_ONE_CLARIFICATION');
    expect(act.secondary).toBeNull();
    expect(act.contextNote).toContain('只澄清一项缺失信息：日期');
  });

  it('没有识别出明确任务时，区分随口分享和明确求助', () => {
    expect(decide('越想把事情做好，反而越不敢开始。').responseMove).toBe('ANSWER_NOW');
    expect(decide('能帮我个忙吗？').essentialMissing).toEqual(['需要帮忙的具体事项']);
  });

  it('个人观察可以自然接话，同一句明确提问仍优先答问题', () => {
    expect(decide('我最近发现，越想把事情做好，反而越不敢开始。').responseMove).toBe('CONTINUE_WITHOUT_QUESTION');
    expect(understandDialogue('我最近发现，越想做好越不敢开始，这是为什么？').dialogueAct).toBe('ASK_EXPLANATION');
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
