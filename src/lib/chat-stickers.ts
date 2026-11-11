export const CHAT_STICKERS = {
  celebrate: { src: '/stickers/celebrate.png', alt: '庆祝一下' },
  laugh: { src: '/stickers/laugh.png', alt: '笑出眼泪' },
  wave: { src: '/stickers/wave.png', alt: '打招呼' },
  cheer: { src: '/stickers/cheer.png', alt: '加油' },
  thumbsUp: { src: '/stickers/thumbs-up.png', alt: '点赞' },
  noted: { src: '/stickers/noted.png', alt: '收到' },
  hug: { src: '/stickers/hug.png', alt: '抱抱' },
  thinking: { src: '/stickers/thinking.png', alt: '思考' },
  surprised: { src: '/stickers/surprised.png', alt: '惊讶' },
  sleepy: { src: '/stickers/sleepy.png', alt: '困困' },
  thanks: { src: '/stickers/thanks.png', alt: '谢谢' },
  night: { src: '/stickers/night.png', alt: '晚安' }
} as const;

export type ChatSticker = keyof typeof CHAT_STICKERS;

export function isChatSticker(value: unknown): value is ChatSticker {
  return typeof value === 'string' && Object.hasOwn(CHAT_STICKERS, value);
}

export const STICKER_COOLDOWN_REPLIES = 12;
const STICKER_IDS = Object.keys(CHAT_STICKERS) as ChatSticker[];

/** Sample only after the message fits a light, clearly positive context. */
export function chooseChatSticker(
  message: string,
  recentReplies: ReadonlyArray<{ sticker?: string | null }>,
  random: () => number = Math.random
): ChatSticker | undefined {
  const text = message.trim();
  if (/(?:不要|别|禁止|不用|无需).{0,8}(?:表情包|贴纸)|\b(?:no|don['’]t send)\s+(?:stickers?|memes?)\b/i.test(text)) return;
  const request = /^(?:请|能不能|可以|麻烦)?\s*(?:你)?(?:给我)?\s*(?:发|来)(?:我)?(?:一?个|一张|点)?(?:[「“])?(庆祝|大笑|打招呼|加油|点赞|收到|抱抱|思考|惊讶|困困|谢谢|晚安)?(?:[」”])?(?:的)?(?:表情包|贴纸)[吧呀吗！!。？?\s]*$/u.exec(text);
  if (request?.[1]) {
    if (request[1] === '庆祝') return 'celebrate';
    if (request[1] === '大笑') return 'laugh';
    return STICKER_IDS.find((id) => CHAT_STICKERS[id].alt === request[1]);
  }
  if (request) {
    const choices = STICKER_IDS.filter((id) => id !== recentReplies.find(({ sticker }) => isChatSticker(sticker))?.sticker);
    return choices[Math.floor(random() * choices.length)] ?? 'wave';
  }
  if (/^(?:please )?(?:send me|show me) (?:a )?sticker[.!?\s]*$/i.test(text)) return 'wave';
  if (recentReplies.slice(0, STICKER_COOLDOWN_REPLIES).some(({ sticker }) => isChatSticker(sticker))) return;

  const reaction = /^(?:哈哈){1,5}(?:哈|[！!。😂🤣\s])*$/u.test(text)
    ? 'laugh'
    : /^(?:耶[！!，,\s]*)?(?:终于)?(?:搞定了|成功了|过关了|通过了|拿到了|做到了|修好了)[！!。🎉\s]*$/u.test(text)
      ? 'celebrate'
      : /^(?:谢啦|谢谢你|多谢)[！!。～~\s]*$/u.test(text)
        ? 'thanks'
        : /^(?:晚安)[！!。～~\s]*$/u.test(text) ? 'night' : undefined;
  if (reaction && random() < 1 / 12) return reaction;
}
