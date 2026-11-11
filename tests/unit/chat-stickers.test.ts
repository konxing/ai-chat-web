import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { CHAT_STICKERS } from '@/lib/chat-stickers';
import { StickerReply } from '@/lib/sticker-reply';

describe('model-selected stickers', () => {
  it('accepts every catalog entry and maps it to a local asset', () => {
    for (const [id, sticker] of Object.entries(CHAT_STICKERS)) {
      const reply = new StickerReply(false);
      expect(reply.push(`答复\n[[STICKER:auto:${id}]]`)).toBe('答复\n');
      expect(reply.finish().sticker).toBe(id);
      expect(existsSync(`public${sticker.src}`)).toBe(true);
    }
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
});
