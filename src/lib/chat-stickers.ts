export const CHAT_STICKERS = {
  celebrate: { src: '/stickers/celebrate.png', alt: '庆祝一下' },
  laugh: { src: '/stickers/laugh.png', alt: '笑出眼泪' },
  wave: { src: '/stickers/wave.png', alt: '打个招呼' }
} as const;

export type ChatSticker = keyof typeof CHAT_STICKERS;

export function isChatSticker(value: unknown): value is ChatSticker {
  return typeof value === 'string' && Object.hasOwn(CHAT_STICKERS, value);
}

export const STICKER_COOLDOWN_REPLIES = 12;

/** Sample only after the message fits a light, clearly positive context. */
export function chooseChatSticker(
  message: string,
  recentReplies: ReadonlyArray<{ sticker?: string | null }>,
  random: () => number = Math.random
): ChatSticker | undefined {
  const text = message.trim();
  if (/(?:不要|别|禁止|不用|无需).{0,8}(?:表情包|贴纸)|\b(?:no|don['’]t send)\s+(?:stickers?|memes?)\b/i.test(text)) return;
  const request = /^(?:请|能不能|可以|麻烦)?\s*(?:你)?(?:给我)?\s*(?:发|来)(?:我)?(?:一?个|一张|点)?(?:[「“])?(庆祝|大笑|打招呼)?(?:[」”])?(?:的)?(?:表情包|贴纸)[吧呀吗！!。？?\s]*$/u.exec(text);
  if (request) return request[1] === '庆祝' ? 'celebrate' : request[1] === '大笑' ? 'laugh' : 'wave';
  if (/^(?:please )?(?:send me|show me) (?:a )?sticker[.!?\s]*$/i.test(text)) return 'wave';
  if (recentReplies.slice(0, STICKER_COOLDOWN_REPLIES).some(({ sticker }) => isChatSticker(sticker))) return;

  const reaction = /^(?:哈哈){1,5}(?:哈|[！!。😂🤣\s])*$/u.test(text)
    ? 'laugh'
    : /^(?:耶[！!，,\s]*)?(?:终于)?(?:搞定了|成功了|过关了|通过了|拿到了|做到了|修好了)[！!。🎉\s]*$/u.test(text)
      ? 'celebrate'
      : undefined;
  if (reaction && random() < 1 / 12) return reaction;
}
