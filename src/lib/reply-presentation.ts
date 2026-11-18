import type { ChatSticker } from './chat-stickers';

export const MAX_REPLY_SEGMENTS = 3;
export const MAX_REPLY_STICKERS = 3;

export type ReplyPart = { type: 'text'; text: string } | { type: 'sticker'; sticker: ChatSticker };

/** Rebuild the model's text/image order for completed and reloaded messages. */
export function orderedReplyParts(
  content: string,
  segmentOffsets: readonly number[],
  stickers: readonly ChatSticker[],
  stickerOffsets: readonly number[] | undefined
): ReplyPart[] | undefined {
  if (!stickers.length || !stickerOffsets || stickers.length !== stickerOffsets.length ||
    stickerOffsets.some((offset) => offset > content.length)) return undefined;
  const boundaries = [...new Set([0, ...segmentOffsets, ...stickerOffsets, content.length])].sort((a, b) => a - b);
  const parts: ReplyPart[] = [];
  let previous = 0;
  let stickerIndex = 0;
  for (const offset of boundaries) {
    const text = content.slice(previous, offset).trim();
    if (text) parts.push({ type: 'text', text });
    while (stickerIndex < stickers.length && stickerOffsets[stickerIndex] === offset) {
      parts.push({ type: 'sticker', sticker: stickers[stickerIndex++] });
    }
    previous = offset;
  }
  return parts;
}
