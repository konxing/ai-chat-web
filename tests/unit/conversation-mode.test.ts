import { describe, expect, it } from 'vitest';
import { detectConversationMode } from '@/lib/cognitive/conversation/mode/mode-detector';
import { modeInstruction, MODE_LABELS } from '@/lib/cognitive/conversation/mode/conversation-mode';

describe('detectConversationMode：规则式、不增加模型调用', () => {
  it('当前会话明确要求优先于主题关键词', () => {
    // 内容含技术词，但用户明确要"像老师一样教我" → TUTOR。
    const got = detectConversationMode({ content: '这个内核驱动像老师一样教我' });
    expect(got.mode).toBe('TUTOR');
    expect(got.explicit).toBe(true);
  });

  it('"不要列点，直接交流" → 自然交流', () => {
    const got = detectConversationMode({ content: '不要列点，直接交流' });
    expect(got.mode).toBe('NATURAL_CHAT');
    expect(got.explicit).toBe(true);
  });

  it('技术主题 → 技术专家', () => {
    const got = detectConversationMode({ content: 'SONiC 交换机内核驱动故障怎么排查' });
    expect(got.mode).toBe('TECHNICAL_EXPERT');
    expect(got.explicit).toBe(false);
  });

  it('情绪表达 → 情绪交流', () => {
    const got = detectConversationMode({ content: '最近压力好大，心里很烦' });
    expect(got.mode).toBe('EMOTIONAL');
  });

  it('数学/编程学习 → 教学', () => {
    const got = detectConversationMode({ content: '这道积分题怎么做' });
    expect(got.mode).toBe('TUTOR');
  });

  it('无信号默认自然交流', () => {
    const got = detectConversationMode({ content: '你好' });
    expect(got.mode).toBe('NATURAL_CHAT');
    expect(got.secondary).toBeNull();
  });

  it('复杂技术+教学可共存（primary+secondary）', () => {
    const got = detectConversationMode({ content: '教我理解这个数据库架构的底层原理，怎么做' });
    expect(['TECHNICAL_EXPERT', 'TUTOR']).toContain(got.mode);
  });
});

describe('modeInstruction：模式说明渲染', () => {
  it('包含模式中文名与要求', () => {
    const text = modeInstruction('TUTOR');
    expect(text).toContain(MODE_LABELS.TUTOR);
    expect(text).toContain('为什么');
  });
});
