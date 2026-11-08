import { describe, expect, it } from 'vitest';
import { renderKnowledgePolicy } from '@/lib/cognitive/conversation/knowledge/knowledge-synthesis';

describe('知识融合策略：只在该深入的模式注入', () => {
  it('深度/研究/技术/教学模式注入知识组织+证据约束', () => {
    for (const mode of ['DEEP_DISCUSSION', 'RESEARCH', 'TECHNICAL_EXPERT', 'TUTOR'] as const) {
      const text = renderKnowledgePolicy(mode) ?? '';
      expect(text).toContain('因果');
      expect(text).toContain('多视角');
      expect(text).toContain('不编造');
    }
  });

  it('自然闲聊/情绪交流不注入（避免把简单交流扩成报告）', () => {
    expect(renderKnowledgePolicy('NATURAL_CHAT')).toBeNull();
    expect(renderKnowledgePolicy('EMOTIONAL')).toBeNull();
  });

  it('证据约束要求区分事实与推断、说明时效', () => {
    const text = renderKnowledgePolicy('RESEARCH') ?? '';
    expect(text).toContain('事实');
    expect(text).toContain('推断');
    expect(text).toContain('时效');
  });
});
