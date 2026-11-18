import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { CHAT_STICKERS, chatStickerImage, type PersonalStickerId } from '@/lib/chat-stickers';
import { StickerReply, stickerReplyPrompt, type StickerReplyEvent } from '@/lib/sticker-reply';

function joinedTextEvents(events: readonly StickerReplyEvent[]): StickerReplyEvent[] {
  const result: StickerReplyEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.type === 'text' && previous?.type === 'text') previous.text += event.text;
    else result.push({ ...event });
  }
  return result;
}

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

  it('hides echoed annotations and only recovers available sticker choices within normal limits', () => {
    for (const [chunks, cooldown, sticker] of [
      [['好。\n（已随这条', '回复发送表情包：抱抱）'], false, 'hug'],
      [['好。\n（已随这条回复发送表情包：比心）'], true, undefined],
      [['好。\n（已随这条回复发送表情包：不存在）'], false, undefined],
      [['好。\n（历史配图：抱抱）'], false, undefined],
      [['好。\n[[STICKER:requested:抱抱]]'], true, 'hug']
    ] as const) {
      const reply = new StickerReply(cooldown);
      expect(chunks.map((chunk) => reply.push(chunk)).join('')).toBe('好。\n');
      expect(reply.finish().sticker).toBe(sticker);
    }
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

  it('keeps interleaved text and pictures in the same order across every stream boundary', () => {
    const source = '这张给你递茶。\n[[STICKER:requested:wave9]]\n[[MESSAGE_BREAK]]\n' +
      '猫猫也来凑热闹。\n[[STICKER:requested:wave12]]\n还想看吗？';
    const expected: StickerReplyEvent[] = [
      { type: 'text', text: '这张给你递茶。\n' },
      { type: 'sticker', sticker: 'wave9' },
      { type: 'text', text: '\n[[MESSAGE_BREAK]]\n猫猫也来凑热闹。\n' },
      { type: 'sticker', sticker: 'wave12' },
      { type: 'text', text: '\n还想看吗？' }
    ];
    const chunkings = Array.from({ length: source.length + 1 }, (_, index) =>
      [source.slice(0, index), source.slice(index)]);
    chunkings.push([...source]);
    for (const chunks of chunkings) {
      const reply = new StickerReply(true, [], true);
      const events = chunks.flatMap((chunk) => reply.pushEvents(chunk));
      const complete = reply.finish();
      if (complete.text) events.push({ type: 'text', text: complete.text });
      expect(joinedTextEvents(events)).toEqual(expected);
      expect(complete.stickers).toEqual(['wave9', 'wave12']);
    }
  });

  it('preserves a valid expressive selection when later text or a bad marker follows', () => {
    for (const suffix of [
      '\n下一句话。',
      '\n[[STICKER:requested:missing]]',
      '\n[[STICKER:requested:wave',
      '\n[[STICKER:requested:\n下一句话。',
      '\n（历史配图：抱抱）'
    ]) {
      const reply = new StickerReply(false, [], true);
      reply.push(`递茶。\n[[STICKER:auto:wave9]]${suffix}`);
      expect(reply.finish().stickers).toEqual(['wave9']);
    }
  });

  it('applies the expressive limit across separate markers and respects cooldown for each choice', () => {
    const reply = new StickerReply(true, [], true);
    const events = reply.pushEvents([
      '[[STICKER:auto:laugh]]',
      '[[STICKER:requested:wave9]]',
      '[[STICKER:auto:wave]]',
      '[[STICKER:requested:wave12,hug]]',
      '[[STICKER:requested:noted]]'
    ].join('\n'));
    expect(events.filter((event) => event.type === 'sticker')).toEqual([
      { type: 'sticker', sticker: 'wave9' },
      { type: 'sticker', sticker: 'wave12' },
      { type: 'sticker', sticker: 'hug' }
    ]);
    expect(reply.finish().stickers).toEqual(['wave9', 'wave12', 'hug']);
  });

  it('never turns expressive history records or unavailable personal references into new pictures', () => {
    const id = `u${'2'.repeat(32)}` as PersonalStickerId;
    const reply = new StickerReply(false, [{ id, label: '猫猫鼓掌' }], true);
    const events = reply.pushEvents([
      '（历史配图：抱抱）',
      '[[STICKER:requested:personal1]]',
      `[[STICKER:requested:${id}]]`,
      '[[STICKER:requested:personal2,wave]]',
      '（历史配图：猫猫鼓掌）',
      '这张给你递茶。'
    ].join('\n'));
    expect(events.filter((event) => event.type === 'sticker')).toEqual([
      { type: 'sticker', sticker: id }
    ]);
    expect(reply.finish().stickers).toEqual([id]);
  });

  it('does not invent a picture from a textual promise without a model selection', () => {
    const reply = new StickerReply(false, [], true);
    expect(reply.pushEvents('这张给你递茶，再来个猫猫探头。')).toEqual([
      { type: 'text', text: '这张给你递茶，再来个猫猫探头。' }
    ]);
    expect(reply.finish().stickers).toBeUndefined();
  });
});
