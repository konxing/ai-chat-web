import { describe, expect, it } from 'vitest';
import { buildConversationState, renderStateBrief } from '@/lib/cognitive/conversation/state/conversation-state';
import { understandDialogue } from '@/lib/cognitive/conversation/understanding/dialogue-act';
import { selectResponseAct } from '@/lib/cognitive/conversation/planning/response-act';
import { buildConversationPrompt } from '@/lib/cognitive/conversation/prompts/prompt-builder';
import { DEFAULT_CONVERSATION_STYLE } from '@/lib/cognitive/conversation/core/conversation-policy';
import { selectDialogueExampleFor } from '@/lib/cognitive/conversation/style/style-examples';

describe('B1 纠正后在 TTL 内持续抑制重犯错', () => {
  it('纠正之后的普通轮次仍带"不再推送排障"提示', () => {
    const recent = [
      { role: 'user' as const, content: '今天那个 Bug 搞得心烦。' },
      { role: 'assistant' as const, content: '我给你几个排障步骤。' },
      { role: 'user' as const, content: '我不是来排查，我就想聊两句。' },
      { role: 'assistant' as const, content: '好，不排查。想从哪说起？' }
    ];
    const current = '那个 Bug 还是没好。';
    const u = understandDialogue(current);
    const state = buildConversationState(recent, current, u);
    const act = selectResponseAct(u, state, current);
    expect(act.primary).not.toBe('CORRECT_COURSE'); // 当前轮本身不是纠正
    expect(act.contextNote).toContain('不再推送排障');
  });

  it('"再深入点"这类正常追加不产生抑制提示', () => {
    const recent = [
      { role: 'user' as const, content: '聊聊睡眠。' },
      { role: 'assistant' as const, content: '想从哪方面说？' }
    ];
    const current = '再深入点。';
    const u = understandDialogue(current);
    const state = buildConversationState(recent, current, u);
    const act = selectResponseAct(u, state, current);
    expect(act.contextNote ?? '').not.toContain('此前用户纠正过');
  });
});

describe('v1.3 极简对话状态', () => {
  it('自然转场停止旧话题的追问和纠正指令，保留长期语言要求', () => {
    const recent = [
      { role: 'user' as const, content: '以后用中文回答。' },
      { role: 'user' as const, content: '我不是来排查，我只是想聊聊。' },
      { role: 'assistant' as const, content: '那你想聊这个 Bug 的哪一块？' }
    ];
    const current = '算了，先聊聊别的。';
    const u = understandDialogue(current);
    const state = buildConversationState(recent, current, u);
    const act = selectResponseAct(u, state, current);
    expect(state.openLoop).toBeNull();
    expect(act.primary).toBe('ANSWER');
    expect(act.contextNote).toContain('无需评论、总结或道歉');
    expect(act.contextNote).toContain('用中文回答');

    const followup = '为什么冰会浮起来？';
    const next = buildConversationState([...recent, { role: 'user', content: current }], followup);
    expect(next.openLoop).toBeNull();
    expect(next.repairLedger).toEqual([]);
  });

  it('提到换话题不等于要求换话题', () => {
    const state = buildConversationState([], '为什么有人总说“换个话题”？');
    expect(state.currentRepair).toBeNull();
  });

  it('上轮已问未答 → 状态提示不要重复同一个问题', () => {
    const recent = [
      { role: 'user' as const, content: '就是那个问题。' },
      { role: 'assistant' as const, content: '你是指缓存问题吗？' }
    ];
    const current = '嗯';
    const u = understandDialogue(current);
    const state = buildConversationState(recent, current, u);
    const brief = renderStateBrief(state);
    expect(brief).toContain('不要重复同一个问题');
  });

  it('当前技术话题 → 状态含"当前话题：技术"', () => {
    const current = '为什么网络会抖动？';
    const u = understandDialogue(current);
    const state = buildConversationState([], current, u);
    expect(renderStateBrief(state)).toContain('当前话题：技术');
  });
});

describe('A.5 状态优先于示例，超预算原因可观测', () => {
  it('预算够核心+动作+状态、不够示例：保留状态、丢弃示例', () => {
    const built = buildConversationPrompt({
      style: DEFAULT_CONVERSATION_STYLE,
      versionContent: '核心原则',
      planText: 'P'.repeat(100),
      stateText: 'S'.repeat(50),
      examplesText: 'E'.repeat(300),
      maxChars: 170
    });
    expect(built.parts.some((p) => p.name === 'state')).toBe(true);
    expect(built.parts.some((p) => p.name === 'examples')).toBe(false);
    expect(built.truncationReasons.some((r) => r.name === 'examples' && r.reason === 'budget')).toBe(true);
  });
});

describe('A.3 示例按"动作+话题"择优', () => {
  it('同一动作下，与近期话题更接近的示例优先选中', () => {
    const { example, diagnostics } = selectDialogueExampleFor('SHARE_PROGRESS', {
      recentText: '拖了很久的报告总算写完了'
    });
    expect(example).not.toBeNull();
    expect(diagnostics.reason).toBe('act+topic');
    expect(diagnostics.selectedId).toBe('d6');
  });

  it('无近期文本时仍按动作命中', () => {
    const { diagnostics } = selectDialogueExampleFor('SHARE_PROGRESS');
    expect(diagnostics.reason).toBe('act-match');
  });
});
