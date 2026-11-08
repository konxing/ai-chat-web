import { describe, expect, it } from 'vitest';
import { checkResponseQuality } from '@/lib/cognitive/conversation/quality/response-quality';

describe('checkResponseQuality：轻量程序检查，不调模型', () => {
  it('模板开头被标记', () => {
    const q = checkResponseQuality({ text: '这是一个非常好的问题。我们来分析。' });
    expect(q.templateOpening).toBe(true);
    expect(q.flags).toContain('template_opening');
    expect(q.naturalness).toBeLessThan(1);
  });

  it('自然回答不被误报', () => {
    const q = checkResponseQuality({ text: '拖了这么久终于收尾，松了口气吧。是内容难写，还是没时间？' });
    expect(q.flags).toEqual([]);
    expect(q.naturalness).toBe(1);
  });

  it('首先其次最后机械结构被标记', () => {
    const q = checkResponseQuality({ text: '首先，它很快。其次，它很稳。最后，它很便宜。' });
    expect(q.mechanicalEnumerators).toBe(true);
  });

  it('短回答带总结尾 → 无必要总结', () => {
    const q = checkResponseQuality({ text: '答案是42。总之，记住42。' });
    expect(q.unnecessarySummary).toBe(true);
  });

  it('重复句子被标记', () => {
    const q = checkResponseQuality({ text: '这个方案可行。这个方案可行。' });
    expect(q.repeatedSentence).toBe(true);
  });

  it('用户要求不列点却列点 → 标记', () => {
    const q = checkResponseQuality({ text: '- 第一点\n- 第二点', userAskedNoList: true });
    expect(q.listsWhenAskedNotTo).toBe(true);
  });

  it('用户没要求时列点不标记', () => {
    const q = checkResponseQuality({ text: '- 第一点\n- 第二点', userAskedNoList: false });
    expect(q.listsWhenAskedNotTo).toBe(false);
  });
});
