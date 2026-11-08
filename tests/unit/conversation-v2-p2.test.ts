import { describe, expect, it } from 'vitest';
import { renderGlobalPolicy, LANGUAGE_RULES, DEFAULT_CONVERSATION_STYLE } from '@/lib/cognitive/conversation/core/conversation-policy';
import { buildConversationPrompt } from '@/lib/cognitive/conversation/prompts/prompt-builder';
import { selectDialogueExamples, renderDialogueExamples } from '@/lib/cognitive/conversation/style/style-examples';

describe('P2 naturalness 可观测（F-03）', () => {
  it('高/低自然度产生不同提示词', () => {
    const high = renderGlobalPolicy({ ...DEFAULT_CONVERSATION_STYLE, naturalness: 'high' });
    const low = renderGlobalPolicy({ ...DEFAULT_CONVERSATION_STYLE, naturalness: 'low' });
    expect(high).not.toBe(low);
    expect(high).toContain('自然交流');
    expect(low).toContain('信息密度高');
  });

  it('全局原则压缩到 ≤6 条且含诚实约束', () => {
    expect(LANGUAGE_RULES.length).toBeLessThanOrEqual(6);
    const text = renderGlobalPolicy();
    expect(text).toContain('不假装');
  });
});

describe('P2 预算先决策后分配，不裁示例（F-07）', () => {
  it('超预算时先丢通用模式/知识，保留示例与回应动作', () => {
    const built = buildConversationPrompt({
      style: DEFAULT_CONVERSATION_STYLE,
      planText: '【本轮回应动作】先承接。',
      examplesText: '【多轮示例】用户：x\n助手：y',
      modeText: '模式'.repeat(400),
      knowledgeText: '知识'.repeat(400),
      maxChars: 700
    });
    const names = built.parts.map((p) => p.name);
    expect(names).toContain('plan');
    expect(names).toContain('examples');
    expect(built.truncated).toBe(true);
  });
});

describe('P2 多轮示例按话语行为选 0-2 组', () => {
  it('纠错行为选到纠正示例', () => {
    const ex = selectDialogueExamples('CORRECT_ASSISTANT');
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.length).toBeLessThanOrEqual(2);
    const text = renderDialogueExamples(ex) ?? '';
    expect(text).toContain('多轮示例');
    expect(text).toContain('我只是想聊聊');
  });

  it('分享行为选到承接示例，不冒充真实历史', () => {
    const ex = selectDialogueExamples('SHARE_PROGRESS');
    const text = renderDialogueExamples(ex) ?? '';
    expect(text).toContain('非用户真实历史');
  });
});
