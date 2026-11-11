import { describe, expect, it } from 'vitest';
import { chooseChatSticker, STICKER_COOLDOWN_REPLIES } from '@/lib/chat-stickers';

describe('chat stickers', () => {
  it('shows an explicitly requested sticker even during the automatic cooldown', () => {
    expect(chooseChatSticker('给我发个表情包', [{ sticker: 'laugh' }], () => 1)).toBe('wave');
    expect(chooseChatSticker('能不能给我发一张庆祝表情包？', [], () => 1)).toBe('celebrate');
  });

  it('samples only clearly playful or celebratory turns', () => {
    expect(chooseChatSticker('哈哈哈哈！', [], () => 0)).toBe('laugh');
    expect(chooseChatSticker('终于修好了！', [], () => 0)).toBe('celebrate');
    expect(chooseChatSticker('终于修好了！', [], () => 1 / 12)).toBeUndefined();
    expect(chooseChatSticker('哈哈，但我真的很难过', [], () => 0)).toBeUndefined();
    expect(chooseChatSticker('不要发表情包', [], () => 0)).toBeUndefined();
  });

  it('suppresses automatic stickers until enough text replies have intervened', () => {
    const textReplies = Array.from({ length: STICKER_COOLDOWN_REPLIES }, () => ({ sticker: null }));
    const sticker = { sticker: 'wave' };
    expect(chooseChatSticker('哈哈哈', [...textReplies.slice(1), sticker], () => 0)).toBeUndefined();
    expect(chooseChatSticker('哈哈哈', [...textReplies, sticker], () => 0)).toBe('laugh');
  });
});
