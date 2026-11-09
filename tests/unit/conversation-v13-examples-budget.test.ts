import { describe, expect, it } from 'vitest';
import { selectDialogueExampleFor, DIALOGUE_EXAMPLE_BUDGET_CHARS } from '@/lib/cognitive/conversation/style/style-examples';
import { buildConversationPrompt } from '@/lib/cognitive/conversation/prompts/prompt-builder';
import { DEFAULT_CONVERSATION_STYLE } from '@/lib/cognitive/conversation/core/conversation-policy';
import { understandDialogue } from '@/lib/cognitive/conversation/understanding/dialogue-act';
import { buildConversationState } from '@/lib/cognitive/conversation/state/conversation-state';
import { selectResponseAct } from '@/lib/cognitive/conversation/planning/response-act';

describe('A.3 多轮示例预算与引用诊断', () => {
  it('预算充足：按话语行为选中 1 组并给出诊断', () => {
    const { example, diagnostics } = selectDialogueExampleFor('SHARE_PROGRESS', { budget: DIALOGUE_EXAMPLE_BUDGET_CHARS });
    expect(example).not.toBeNull();
    expect(example!.turns.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.selectedId).toBe(example!.id);
    expect(diagnostics.reason).toBe('act-match');
    expect(diagnostics.trimmed).toBe(false);
  });

  it('每轮最多 1 组（不注入 2 组）', () => {
    const { example } = selectDialogueExampleFor('CORRECT_ASSISTANT');
    expect(example).not.toBeNull();
  });

  it('预算不足：可完全不注入，并记录 over-budget', () => {
    const { example, diagnostics } = selectDialogueExampleFor('SHARE_PROGRESS', { budget: 20 });
    expect(example).toBeNull();
    expect(diagnostics.reason).toBe('over-budget');
    expect(diagnostics.selectedId).toBeNull();
  });

  it('naturalness=low 不注入示例', () => {
    const { example, diagnostics } = selectDialogueExampleFor('SHARE_PROGRESS', { naturalness: 'low' });
    expect(example).toBeNull();
    expect(diagnostics.reason).toBe('low-naturalness');
  });

  it('无匹配话语行为：no-match', () => {
    const { example, diagnostics } = selectDialogueExampleFor('ASK_FACT');
    expect(example).toBeNull();
    expect(diagnostics.reason).toBe('no-match');
  });
});

describe('A.5 Prompt 预算可观测：注入模块与截断原因', () => {
  it('超预算时记录被丢弃模块及原因，核心原则保留（partial）', () => {
    const built = buildConversationPrompt({
      style: DEFAULT_CONVERSATION_STYLE,
      planText: 'P'.repeat(300),
      examplesText: 'E'.repeat(300),
      modeText: 'M'.repeat(300),
      knowledgeText: 'K'.repeat(300),
      maxChars: 120
    });
    expect(built.truncated).toBe(true);
    expect(built.budget).toBe(120);
    expect(built.usedChars).toBeLessThanOrEqual(120);
    expect(built.parts.some((p) => p.name === 'global-policy')).toBe(true);
    expect(built.truncationReasons.some((r) => r.name === 'global-policy' && r.reason === 'partial')).toBe(true);
    expect(built.truncationReasons.some((r) => r.reason === 'budget')).toBe(true);
  });

  it('预算充足时不报截断', () => {
    const built = buildConversationPrompt({ style: DEFAULT_CONVERSATION_STYLE, planText: '短', maxChars: 5000 });
    expect(built.truncated).toBe(false);
    expect(built.truncationReasons).toHaveLength(0);
    expect(built.usedChars).toBeGreaterThan(0);
  });
});

describe('A.5 naturalness 有可观测行为差异（不只是文本）', () => {
  it('同一分享句：naturalness=low → 直接回应；high → 承接探索', () => {
    const content = '今天一个 Bug 修了一天还没好。';
    const u = understandDialogue(content);
    const state = buildConversationState([], content, u);
    expect(selectResponseAct(u, state, content, 'low').primary).toBe('ANSWER');
    expect(selectResponseAct(u, state, content, 'high').primary).toBe('ACKNOWLEDGE_AND_EXPLORE');
  });
});