import { describe, expect, it } from 'vitest';
import { understandDialogue } from '@/lib/cognitive/conversation/understanding/dialogue-act';
import { buildConversationState } from '@/lib/cognitive/conversation/state/conversation-state';
import { selectResponseAct } from '@/lib/cognitive/conversation/planning/response-act';

describe('P1 意图区分：话题域≠话语行为', () => {
  it('"今天一个Bug修了一天还没好" → 分享/疲惫，不进入故障排查', () => {
    const u = understandDialogue('今天一个 Bug 修了一天还没好。');
    expect(u.topicDomain).toBe('technical');
    expect(['SHARE_PROGRESS', 'VENT']).toContain(u.dialogueAct);
    const act = selectResponseAct(u, buildConversationState([], '今天一个 Bug 修了一天还没好。'));
    expect(act.primary).toBe('ACKNOWLEDGE_AND_EXPLORE');
  });

  it('"这个Bug为什么复现不了" → 技术诊断/解释', () => {
    const u = understandDialogue('这个 Bug 为什么复现不了？');
    expect(u.dialogueAct).toBe('ASK_EXPLANATION');
    const act = selectResponseAct(u, buildConversationState([], ''));
    expect(['EXPLAIN', 'ANSWER']).toContain(act.primary);
  });

  it('"日志显示KNET没收到包，排查思路？" → 直接专业诊断', () => {
    const u = understandDialogue('日志显示 KNET 没收到包，排查思路？');
    expect(u.topicDomain).toBe('technical');
    const act = selectResponseAct(u, buildConversationState([], ''));
    expect(act.primary).not.toBe('ACKNOWLEDGE_AND_EXPLORE');
  });
});

describe('P1 纠错与跨轮状态', () => {
  it('"不是，我只是想聊聊" → 触发修复', () => {
    const u = understandDialogue('不是，我只是想聊聊，不要给方案。');
    expect(u.dialogueAct).toBe('CORRECT_ASSISTANT');
    expect(u.needsRepair).toBe(true);
    const act = selectResponseAct(u, buildConversationState([], '不是，我只是想聊聊，不要给方案。'));
    expect(act.primary).toBe('CORRECT_COURSE');
  });

  it('跨轮：分享→助手提问→用户纠正，下一轮修正不重复原策略', () => {
    const recent = [
      { role: 'user' as const, content: '最近状态不好。' },
      { role: 'assistant' as const, content: '我给你几个建议吧？' }
    ];
    const current = '不是，我只是想聊聊。';
    const state = buildConversationState(recent, current);
    expect(state.recentCorrection).toBe(true);
    expect(state.openLoop).not.toBeNull(); // 上轮助手提问未答
    const u = understandDialogue(current);
    const act = selectResponseAct(u, state);
    expect(act.primary).toBe('CORRECT_COURSE');
  });

  it('防连环追问：上轮已问且未答，本轮模糊不再追问', () => {
    const recent = [
      { role: 'user' as const, content: '就是那个问题。' },
      { role: 'assistant' as const, content: '你是指缓存问题吗？' }
    ];
    const state = buildConversationState(recent, '嗯');
    const u = understandDialogue('嗯');
    const act = selectResponseAct(u, state);
    expect(act.primary).not.toBe('ASK_ONE_CLARIFICATION');
  });
});
