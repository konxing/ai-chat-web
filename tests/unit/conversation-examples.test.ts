import { describe, expect, it } from 'vitest';
import { selectExamples, renderExamples, STYLE_EXAMPLES, EXAMPLES_VERSION } from '@/lib/cognitive/conversation/style/style-examples';

describe('示例对话库：按模式选少量、控制 token', () => {
  it('每个模式最多取 2 条', () => {
    for (const mode of ['NATURAL_CHAT', 'TUTOR', 'TECHNICAL_EXPERT'] as const) {
      expect(selectExamples(mode).length).toBeLessThanOrEqual(2);
    }
  });

  it('primary+secondary 合并仍不超过 2 条', () => {
    expect(selectExamples('TECHNICAL_EXPERT', 'TUTOR').length).toBeLessThanOrEqual(2);
  });

  it('选出的示例都属于当前模式集合', () => {
    const got = selectExamples('TUTOR', 'TECHNICAL_EXPERT');
    for (const e of got) expect(['TUTOR', 'TECHNICAL_EXPERT']).toContain(e.mode);
  });

  it('空示例渲染为 null（不注入空块）', () => {
    expect(renderExamples([])).toBeNull();
  });

  it('渲染带"仅示范风格"声明，防止照抄内容', () => {
    const text = renderExamples(selectExamples('NATURAL_CHAT')) ?? '';
    expect(text).toContain('仅示范风格');
    expect(text).toContain('用户：');
    expect(text).toContain('助手：');
  });

  it('示例库有版本且非空', () => {
    expect(EXAMPLES_VERSION).toBeGreaterThanOrEqual(1);
    expect(STYLE_EXAMPLES.length).toBeGreaterThan(0);
  });
});
