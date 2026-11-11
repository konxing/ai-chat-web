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
  night: { src: '/stickers/night.png', alt: '晚安' },
  celebrate1: { src: '/stickers/celebrate1.png', alt: '搞定啦' },
  celebrate2: { src: '/stickers/celebrate2.png', alt: '好耶' },
  celebrate3: { src: '/stickers/celebrate3.png', alt: '撒花' },
  celebrate4: { src: '/stickers/celebrate4.png', alt: '干杯' },
  celebrate5: { src: '/stickers/celebrate5.png', alt: '大功告成' },
  celebrate6: { src: '/stickers/celebrate6.png', alt: '开香槟' },
  celebrate7: { src: '/stickers/celebrate7.png', alt: '鼓掌' },
  celebrate8: { src: '/stickers/celebrate8.png', alt: '值得庆祝' },
  celebrate9: { src: '/stickers/celebrate9.png', alt: '太好了' },
  celebrate10: { src: '/stickers/celebrate10.png', alt: '通关啦' },
  celebrate11: { src: '/stickers/celebrate11.png', alt: '起飞' },
  celebrate12: { src: '/stickers/celebrate12.png', alt: '漂亮' },
  laugh1: { src: '/stickers/laugh1.png', alt: '笑翻了' },
  laugh2: { src: '/stickers/laugh2.png', alt: '憋不住了' },
  laugh3: { src: '/stickers/laugh3.png', alt: '嘿嘿' },
  laugh4: { src: '/stickers/laugh4.png', alt: '哈哈哈' },
  laugh5: { src: '/stickers/laugh5.png', alt: '笑到拍桌' },
  laugh6: { src: '/stickers/laugh6.png', alt: '乐开花' },
  laugh7: { src: '/stickers/laugh7.png', alt: '没绷住' },
  laugh8: { src: '/stickers/laugh8.png', alt: '会心一笑' },
  laugh9: { src: '/stickers/laugh9.png', alt: '笑眯眯' },
  laugh10: { src: '/stickers/laugh10.png', alt: '偷笑' },
  laugh11: { src: '/stickers/laugh11.png', alt: '太好笑了' },
  laugh12: { src: '/stickers/laugh12.png', alt: '笑趴' },
  thanks1: { src: '/stickers/thanks1.png', alt: '辛苦啦' },
  thanks2: { src: '/stickers/thanks2.png', alt: '谢啦' },
  thanks3: { src: '/stickers/thanks3.png', alt: '感激' },
  thanks4: { src: '/stickers/thanks4.png', alt: '有心了' },
  thanks5: { src: '/stickers/thanks5.png', alt: '比心' },
  thanks6: { src: '/stickers/thanks6.png', alt: '心领啦' },
  night1: { src: '/stickers/night1.png', alt: '好梦' },
  night2: { src: '/stickers/night2.png', alt: '早点休息' },
  night3: { src: '/stickers/night3.png', alt: '睡啦' },
  night4: { src: '/stickers/night4.png', alt: '月亮见' },
  night5: { src: '/stickers/night5.png', alt: '打个哈欠' },
  night6: { src: '/stickers/night6.png', alt: '盖被被' },
  wave1: { src: '/stickers/wave1.png', alt: '早上好' },
  wave2: { src: '/stickers/wave2.png', alt: '午安' },
  wave3: { src: '/stickers/wave3.png', alt: '我来啦' },
  wave4: { src: '/stickers/wave4.png', alt: '回头见' },
  wave5: { src: '/stickers/wave5.png', alt: '等一下' },
  wave6: { src: '/stickers/wave6.png', alt: '懂了' },
  wave7: { src: '/stickers/wave7.png', alt: '记下啦' },
  wave8: { src: '/stickers/wave8.png', alt: '好主意' },
  wave9: { src: '/stickers/wave9.png', alt: '给你递茶' },
  wave10: { src: '/stickers/wave10.png', alt: '给你递咖啡' },
  wave11: { src: '/stickers/wave11.png', alt: '来块饼干' },
  wave12: { src: '/stickers/wave12.png', alt: '猫猫探头' }
} as const;

export type ChatSticker = keyof typeof CHAT_STICKERS;

export function isChatSticker(value: unknown): value is ChatSticker {
  return typeof value === 'string' && Object.hasOwn(CHAT_STICKERS, value);
}

export const STICKER_COOLDOWN_REPLIES = 12;
const STICKER_IDS = Object.keys(CHAT_STICKERS) as ChatSticker[];
const STICKER_BY_NAME = new Map(STICKER_IDS.map((id) => [CHAT_STICKERS[id].alt as string, id]));
STICKER_BY_NAME.set('庆祝', 'celebrate');
STICKER_BY_NAME.set('大笑', 'laugh');
const AUTOMATIC_STICKERS = {
  celebrate: ['celebrate', 'celebrate1', 'celebrate2', 'celebrate3', 'celebrate4', 'celebrate5', 'celebrate6', 'celebrate7', 'celebrate8', 'celebrate9', 'celebrate10', 'celebrate11', 'celebrate12'],
  laugh: ['laugh', 'laugh1', 'laugh2', 'laugh3', 'laugh4', 'laugh5', 'laugh6', 'laugh7', 'laugh8', 'laugh9', 'laugh10', 'laugh11', 'laugh12'],
  thanks: ['thanks', 'thanks2', 'thanks3', 'thanks4', 'thanks5', 'thanks6'],
  night: ['night', 'night1', 'night2', 'night3', 'night4', 'night6']
} as const;

/** Sample only after the message fits a light, clearly positive context. */
export function chooseChatSticker(
  message: string,
  recentReplies: ReadonlyArray<{ sticker?: string | null }>,
  random: () => number = Math.random
): ChatSticker | undefined {
  const text = message.trim();
  if (/(?:不要|别|禁止|不用|无需).{0,8}(?:表情包|贴纸)|\b(?:no|don['’]t send)\s+(?:stickers?|memes?)\b/i.test(text)) return;
  const request = /^(?:请|能不能|可以|麻烦)?\s*(?:你)?(?:给我)?\s*(?:发|来)(?:我)?(?:一?个|一张|点)?[「“]?([^\r\n「」“”]{0,12}?)[」”]?(?:的)?(?:表情包|贴纸)[吧呀吗！!。？?\s]*$/u.exec(text);
  if (request?.[1]?.trim()) return STICKER_BY_NAME.get(request[1].trim());
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
  if (!reaction) return;
  const sample = random() * 12;
  if (sample < 1) {
    const choices = AUTOMATIC_STICKERS[reaction];
    return choices[Math.floor(sample * choices.length)];
  }
}
