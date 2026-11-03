import type { AiMessage, ChatContentPart } from '@/lib/ai';

/**
 * 把发给模型的出站消息压成 {role, text}。
 *
 * 为什么要这一层：本轮用户那条消息的 content 是 ChatContentPart[]（要塞 image_url），不是裸字符串，
 * 直接断言 content 会让「文本」和「图片块」混在一个形状里比较。多个测试文件都要看同一件事，
 * 所以放这儿而不是各自复制一份。
 */
export function toOutboundTexts(
  messages: readonly AiMessage[]
): Array<{ role: string; text: string }> {
  return messages.map((message) => ({
    role: message.role,
    text:
      typeof message.content === 'string'
        ? message.content
        : (message.content as ChatContentPart[]).find((part) => part.type === 'text')?.text ?? ''
  }));
}
