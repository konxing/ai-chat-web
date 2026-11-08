import { describe, expect, it } from 'vitest';
import {
  composeSourceExcerpt,
  selectSourceMessageIds,
  wantsSourceDive,
  SOURCE_DIVE_MAX_CHARS,
  SOURCE_DIVE_MAX_SOURCES
} from '@/lib/cognitive/memory-source-dive';

/**
 * 溯源展开：追问细节时回到原始对话。
 * 钉四件事：什么措辞才触发、挑哪几条消息、预算怎么截、来源怎么写。
 */

describe('wantsSourceDive：只有明确要细节才触发', () => {
  it.each([
    ['这 24 个习惯具体是什么？', true],
    ['详细说说这 8 项能力', true],
    ['展开讲讲第一部分', true],
    ['我有哪些核心能力？', true],
    ['把完整清单给我', true],
    ['逐条解释一下', true]
  ])('%s -> %s', (query, expected) => {
    expect(wantsSourceDive(query)).toBe(expected);
  });

  it('普通提问不触发，不多读消息表', () => {
    for (const query of ['我住在哪里？', '我的长期目标是什么？', '你还记得我吗？', '帮我把这段话改温和']) {
      expect(wantsSourceDive(query)).toBe(false);
    }
  });
});

describe('selectSourceMessageIds：按名次挑、去重、封顶', () => {
  it('同一段长文被拆成多条记忆时只取一次', () => {
    const got = selectSourceMessageIds([
      { sourceMessageId: 'm-1' },
      { sourceMessageId: 'm-1' },
      { sourceMessageId: 'm-2' }
    ]);
    expect(got).toEqual(['m-1', 'm-2']);
  });

  it('没有来源的记忆跳过，最多两条', () => {
    const got = selectSourceMessageIds([
      { sourceMessageId: null },
      { sourceMessageId: 'm-1' },
      { sourceMessageId: 'm-2' },
      { sourceMessageId: 'm-3' }
    ]);
    expect(got).toEqual(['m-1', 'm-2']);
    expect(got.length).toBeLessThanOrEqual(SOURCE_DIVE_MAX_SOURCES);
  });
});

describe('composeSourceExcerpt：预算与来源标注', () => {
  it('单条原文完整给出，带会话标题', () => {
    const text = composeSourceExcerpt([
      { messageId: 'm-1', chatId: 'c-1', chatTitle: '个人能力培养体系', text: '我把它归纳为 8 项核心能力…' }
    ]);
    expect(text).toContain('来自《个人能力培养体系》');
    expect(text).toContain('我把它归纳为 8 项核心能力');
  });

  it('没有标题时写明来自之前的对话', () => {
    const text = composeSourceExcerpt([{ messageId: 'm-1', chatId: null, chatTitle: null, text: '我喜欢喝黑咖啡' }]);
    expect(text).toContain('来自之前的对话');
  });

  it('超预算的原文截断并明写「后略」', () => {
    const long = '数'.repeat(SOURCE_DIVE_MAX_CHARS + 500);
    const text = composeSourceExcerpt([{ messageId: 'm-1', chatId: null, chatTitle: null, text: long }]) ?? '';
    expect(text.length).toBeLessThanOrEqual(SOURCE_DIVE_MAX_CHARS + 80);
    expect(text).toContain('（后略）');
  });

  it('一条都没有返回 null（调用方就不加这个块）', () => {
    expect(composeSourceExcerpt([])).toBeNull();
  });

  it('多条按顺序拼接，互不覆盖', () => {
    const text = composeSourceExcerpt([
      { messageId: 'm-1', chatId: 'c-1', chatTitle: 'A', text: '第一条原文' },
      { messageId: 'm-2', chatId: 'c-2', chatTitle: 'B', text: '第二条原文' }
    ]) ?? '';
    expect(text.indexOf('第一条原文')).toBeLessThan(text.indexOf('第二条原文'));
  });
});
