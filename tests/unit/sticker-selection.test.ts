import { describe, expect, it } from 'vitest';
import { availableStickerChoices } from '@/lib/sticker-reply';
import { needsStickerSelectionCheck, validateStickerSelection } from '@/lib/sticker-selection';
import type { PersonalStickerId } from '@/lib/chat-stickers';

describe('verified sticker selections', () => {
  it('offers the complete built-in inventory and only opaque aliases for personal pictures', () => {
    const id = `u${'1'.repeat(32)}` as PersonalStickerId;
    const choices = availableStickerChoices([{ id, label: '我的猫猫' }]);
    expect(choices.size).toBe(201);
    expect(choices.get('personal1')).toEqual({ id, label: '我的猫猫' });
    expect(choices.has(id)).toBe(false);
    expect(choices.get('notoTearsOfJoy')?.label).toBe('笑出眼泪');
  });
  it('checks the screenshot request and image promises, while skipping ordinary conversation', () => {
    expect(needsStickerSelectionCheck('发些别的，比如笑哭', '哭笑的来了，管够。', false)).toBe(true);
    expect(needsStickerSelectionCheck('继续', '笑出眼泪那张，经典款。', false)).toBe(true);
    expect(needsStickerSelectionCheck('你好', '你好呀。', false)).toBe(false);
    expect(needsStickerSelectionCheck('你好', '', true)).toBe(true);
    expect(needsStickerSelectionCheck('继续', '好。', false, true)).toBe(true);
    expect(needsStickerSelectionCheck('继续', '好。', false, false)).toBe(false);
  });
  it('accepts only actual choices within the per-reply limit', () => {
    expect(validateStickerSelection({ action: 'send', stickers: ['notoTearsOfJoy'], reply: '这张很合适。' }, [], false)?.stickers).toEqual(['notoTearsOfJoy']);
    for (const stickers of [['invented-cat'], ['https://example.com/cat.gif'], ['wave', 'hug']]) {
      expect(validateStickerSelection({ action: 'send', stickers, reply: '给你。' }, [], false)).toBeNull();
    }
    expect(validateStickerSelection({ action: 'send', stickers: ['wave', 'hug'], reply: '' }, [], true)?.stickers).toEqual(['wave', 'hug']);
  });
  it('rejects stale or guessed personal IDs and control markers', () => {
    const id = `u${'2'.repeat(32)}` as PersonalStickerId;
    const own = [{ id, label: '我的猫猫' }];
    expect(validateStickerSelection({ action: 'send', stickers: ['personal1'], reply: '' }, own, false)?.stickers).toEqual([id]);
    for (const choice of [id, 'personal2']) expect(validateStickerSelection({ action: 'send', stickers: [choice], reply: '' }, own, false)).toBeNull();
    expect(validateStickerSelection({ action: 'send', stickers: ['personal1'], reply: '' }, [], false)).toBeNull();
    expect(validateStickerSelection({ action: 'send', stickers: ['wave'], reply: '[[STICKER:auto:wave]]' }, [], false)).toBeNull();
  });
  it('returns an honest unavailable result without substituting an unrelated picture', () => {
    const result = validateStickerSelection({ action: 'unavailable', stickers: [], reply: '发不了。' }, [], true);
    expect(result?.reply).toContain('暂时发不了');
    expect(result?.stickers).toEqual([]);
    expect(validateStickerSelection({ action: 'unavailable', stickers: ['hug'], reply: '' }, [], true)).toBeNull();
    expect(validateStickerSelection({ action: 'none', stickers: [], reply: '' }, [], false)).toBeNull();
  });
});
