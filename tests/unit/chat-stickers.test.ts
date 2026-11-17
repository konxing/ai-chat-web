import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { CHAT_STICKERS, chatStickerImage, type PersonalStickerId } from '@/lib/chat-stickers';
import { StickerReply, stickerReplyPrompt } from '@/lib/sticker-reply';

describe('model-selected stickers', () => {
  it('accepts every catalog entry and maps it to a local asset', () => {
    for (const [id, sticker] of Object.entries(CHAT_STICKERS)) {
      const reply = new StickerReply(false);
      expect(reply.push(`答复\n[[STICKER:auto:${id}]]`)).toBe('答复\n');
      expect(reply.finish().sticker).toBe(id);
      expect(existsSync(`public${sticker.src}`)).toBe(true);
    }
  });

  it('ships a non-animated fallback for every built-in animation', () => {
    for (const id of Object.keys(CHAT_STICKERS) as Array<keyof typeof CHAT_STICKERS>) {
      const { src, posterSrc } = chatStickerImage(id);
      if (!posterSrc) continue;
      const animation = readFileSync(`public${src}`);
      const still = readFileSync(`public${posterSrc}`);
      expect(animation.toString('ascii', 8, 12)).toBe('WEBP');
      expect(animation.includes('ANIM')).toBe(true);
      expect(still.toString('ascii', 8, 12)).toBe('WEBP');
      expect(still.includes('ANIM')).toBe(false);
    }
    expect(stickerReplyPrompt(false)).toContain('notoTearsOfJoy=笑出眼泪');
  });

  it('hides split markers and rejects unknown, repeated, unfinished and non-final selections', () => {
    for (const chunks of [
      ['好\n[[ST', 'ICKER:auto:unknown]]'],
      ['好\n[[STICKER:auto:wave]][[STICKER:auto:laugh]]'],
      ['好\n[[STICKER:auto:wave'],
      ['好\n[[STICKER:auto:wave]]']
    ]) {
      const reply = new StickerReply(false);
      expect(chunks.map((chunk) => reply.push(chunk)).join('')).toBe('好\n');
      if (chunks[0].endsWith('wave]]') && !chunks[0].includes('laugh')) {
        expect(reply.push('还有一句')).toBe('还有一句');
      }
      expect(reply.finish()).toEqual({ text: '', sticker: undefined });
    }
  });

  it('enforces the cooldown on spontaneous selections while permitting requested ones', () => {
    const automatic = new StickerReply(true);
    automatic.push('[[STICKER:auto:wave]]');
    expect(automatic.finish().sticker).toBeUndefined();
    const requested = new StickerReply(true);
    requested.push('[[STICKER:requested:wave]]');
    expect(requested.finish().sticker).toBe('wave');
  });

  it('flushes ordinary text held at the end of a chunk', () => {
    const reply = new StickerReply(false);
    expect(reply.push('文字 [' )).toBe('文字 ');
    expect(reply.finish()).toEqual({ text: '[', sticker: undefined });
  });

  it('uses per-turn aliases for personal stickers and rejects guessed or stale identifiers', () => {
    const id = `u${'1'.repeat(32)}` as PersonalStickerId;
    const choices = [{ id, label: '猫猫鼓掌' }];
    expect(stickerReplyPrompt(false, choices)).toContain('"personal1":"猫猫鼓掌"');
    expect(stickerReplyPrompt(false, choices)).not.toContain(id);

    const reply = new StickerReply(false, choices);
    expect(reply.push('好耶！\n[[STICKER:auto:pers')).toBe('好耶！\n');
    expect(reply.push('onal1]]')).toBe('');
    expect(reply.finish().sticker).toBe(id);
    expect(chatStickerImage(id).src).toBe(`/api/account/stickers/${id}`);

    for (const candidate of [id, 'personal2']) {
      const unavailable = new StickerReply(false, choices);
      unavailable.push(`[[STICKER:requested:${candidate}]]`);
      expect(unavailable.finish().sticker).toBeUndefined();
    }
    const emptyLibrary = new StickerReply(false);
    emptyLibrary.push('[[STICKER:requested:personal1]]');
    expect(emptyLibrary.finish().sticker).toBeUndefined();
  });
});
