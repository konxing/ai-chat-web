import { describe, expect, it } from 'vitest';
import { DialogueReplyText } from '@/lib/dialogue-reply';
import { orderedReplyParts } from '@/lib/reply-presentation';

describe('ordered reply presentation', () => {
  it('reconstructs a picture after each matching text bubble and keeps later text', () => {
    const first = '给你递茶。';
    const second = '猫猫也来了。';
    const last = '这句收尾。';
    const content = `${first}\n\n${second}\n\n${last}`;
    const secondStart = first.length + 2;
    const secondEnd = secondStart + second.length;
    expect(orderedReplyParts(
      content,
      [secondStart, secondEnd + 2],
      ['wave9', 'wave12'],
      [first.length, secondEnd]
    )).toEqual([
      { type: 'text', text: first },
      { type: 'sticker', sticker: 'wave9' },
      { type: 'text', text: second },
      { type: 'sticker', sticker: 'wave12' },
      { type: 'text', text: last }
    ]);
  });

  it('preserves the model order for pictures before text and at the same position', () => {
    expect(orderedReplyParts('收到。', [], ['hug', 'wave', 'noted'], [0, 0, 3])).toEqual([
      { type: 'sticker', sticker: 'hug' },
      { type: 'sticker', sticker: 'wave' },
      { type: 'text', text: '收到。' },
      { type: 'sticker', sticker: 'noted' }
    ]);
  });

  it('supports a reply made entirely of pictures without empty text bubbles', () => {
    expect(orderedReplyParts('', [], ['hug', 'notoWave'], [0, 0])).toEqual([
      { type: 'sticker', sticker: 'hug' },
      { type: 'sticker', sticker: 'notoWave' }
    ]);
  });

  it('leaves legacy replies and incomplete position data to the legacy renderer', () => {
    expect(orderedReplyParts('收到。', [], ['noted'], undefined)).toBeUndefined();
    expect(orderedReplyParts('收到。', [], ['noted'], [])).toBeUndefined();
    expect(orderedReplyParts('收到。', [], ['noted'], [4])).toBeUndefined();
    expect(orderedReplyParts('收到。', [], [], [])).toBeUndefined();
  });

  it('keeps a pending text bubble boundary when taking an image checkpoint', () => {
    const events: unknown[] = [];
    const reply = new DialogueReplyText(true, (event) => events.push(event));
    reply.push('第一条。\n[[MESSAGE_BREAK]]\n');
    const position = reply.checkpoint();
    expect(reply.segmentOffsets).toEqual([]);
    reply.push('第二条。');
    reply.finish();

    expect(reply.content).toBe('第一条。\n\n第二条。');
    expect(events.filter((event) => (event as { type: string }).type === 'segment')).toHaveLength(1);
    expect(orderedReplyParts(reply.content, reply.segmentOffsets, ['wave9'], [position])).toEqual([
      { type: 'text', text: '第一条。' },
      { type: 'sticker', sticker: 'wave9' },
      { type: 'text', text: '第二条。' }
    ]);
  });
});
