import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { CHAT_STICKERS, chooseChatSticker, STICKER_COOLDOWN_REPLIES } from '@/lib/chat-stickers';

describe('chat stickers', () => {
  it('can request every catalog entry by name and each has a local image', () => {
    expect(Object.keys(CHAT_STICKERS)).toHaveLength(60);
    for (const [id, sticker] of Object.entries(CHAT_STICKERS)) {
      expect(chooseChatSticker(`发一张「${sticker.alt}」表情包`, [])).toBe(id);
      expect(existsSync(`public${sticker.src}`)).toBe(true);
    }
  });
  it('shows an explicitly requested sticker even during the automatic cooldown', () => {
    expect(chooseChatSticker('给我发个表情包', [{ sticker: 'laugh' }], () => 1)).toBe('wave');
    expect(chooseChatSticker('能不能给我发一张庆祝表情包？', [], () => 1)).toBe('celebrate');
    expect(chooseChatSticker('发个晚安表情包', [], () => 0)).toBe('night');
    expect(chooseChatSticker('给我发个表情包', [{ sticker: 'celebrate' }], () => 0)).toBe('laugh');
  });

  it('samples only clearly playful or celebratory turns', () => {
    expect(chooseChatSticker('哈哈哈哈！', [], () => 0)).toBe('laugh');
    expect(chooseChatSticker('终于修好了！', [], () => 0)).toBe('celebrate');
    expect(chooseChatSticker('终于修好了！', [], () => 0.08)).toBe('celebrate12');
    expect(chooseChatSticker('终于修好了！', [], () => 1 / 12)).toBeUndefined();
    expect(chooseChatSticker('哈哈，但我真的很难过', [], () => 0)).toBeUndefined();
    expect(chooseChatSticker('不要发表情包', [], () => 0)).toBeUndefined();
  });

  it('recognizes conversational requests without mistaking a plain negation for one', () => {
    const recent = [{ sticker: 'laugh' }];
    expect(chooseChatSticker('跟我聊天感觉怎么样？不发个表情包给我吗？', recent, () => 0)).toBe('celebrate');
    expect(chooseChatSticker('今天终于收尾了，顺便发个撒花表情包给我吧。', recent, () => 0)).toBe('celebrate3');
    expect(chooseChatSticker('今天不发表情包。', [], () => 0)).toBeUndefined();
    expect(chooseChatSticker('不发个表情包。', [], () => 0)).toBeUndefined();
    expect(chooseChatSticker('表情包是怎么做出来的？', [], () => 0)).toBeUndefined();
  });

  it('suppresses automatic stickers until enough text replies have intervened', () => {
    const textReplies = Array.from({ length: STICKER_COOLDOWN_REPLIES }, () => ({ sticker: null }));
    const sticker = { sticker: 'wave' };
    expect(chooseChatSticker('哈哈哈', [...textReplies.slice(1), sticker], () => 0)).toBeUndefined();
    expect(chooseChatSticker('哈哈哈', [...textReplies, sticker], () => 0)).toBe('laugh');
  });
});
