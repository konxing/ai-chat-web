import { randomUUID } from 'node:crypto';
import type { AiProvider, Attachment, Chat, Message, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { decryptString, encryptString } from './crypto';
import { ApiError } from './http';
import {
  attachmentName,
  buildAttachmentContext,
  imageDataUrls,
  publicAttachment,
  readAttachmentBuffer,
  type PublicAttachment
} from './files';
import { capabilitiesOf } from './providers';
import type { AiMessage, ChatContentPart } from './ai';

export interface ChatSummary {
  id: string;
  title: string;
  preview: string;
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageDto {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  modelId: string | null;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  attachments: PublicAttachment[];
  createdAt: string;
}

export interface ChatDetailDto {
  id: string;
  title: string;
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageDto[];
  hasOlder: boolean;
}

export function decryptChatTitle(chat: Pick<Chat, 'id' | 'titleCiphertext'>): string {
  try {
    return decryptString(chat.titleCiphertext, `chat-title:${chat.id}`);
  } catch {
    return '无法解密的会话';
  }
}

export function encryptMessage(content: string, messageId: string): string {
  return encryptString(content, `message:${messageId}`);
}

export function decryptMessage(message: Pick<Message, 'id' | 'contentCiphertext'>): string {
  try {
    return decryptString(message.contentCiphertext, `message:${message.id}`);
  } catch {
    return '（消息解密失败）';
  }
}

export function publicMessage(
  message: Message & { attachments?: Attachment[] }
): ChatMessageDto {
  return {
    id: message.id,
    role: message.role,
    content: decryptMessage(message),
    modelId: message.modelId,
    status: message.status,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    attachments: (message.attachments || []).map(publicAttachment),
    createdAt: message.createdAt.toISOString()
  };
}

function previewOf(message: Message | undefined): string {
  if (!message) return '';
  const text = decryptMessage(message)
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[#>*_`~\-\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80);
}

export async function listChats(userId: string): Promise<ChatSummary[]> {
  const rows = await prisma.chat.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: {
      provider: { select: { name: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 }
    }
  });
  return rows.map((chat) => ({
    id: chat.id,
    title: decryptChatTitle(chat),
    preview: previewOf(chat.messages[0]),
    modelId: chat.modelId,
    providerId: chat.modelProviderId,
    providerName: chat.provider?.name ?? null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString()
  }));
}

export async function createChat(input: {
  userId: string;
  provider?: AiProvider | null;
  title?: string;
}): Promise<Chat> {
  const id = randomUUID();
  const title = (input.title?.trim() || '新对话').slice(0, 60);
  return prisma.chat.create({
    data: {
      id,
      userId: input.userId,
      titleCiphertext: encryptString(title, `chat-title:${id}`),
      modelProviderId: input.provider?.id ?? null,
      modelId: input.provider?.modelId ?? null
    }
  });
}

export async function getChatOwned(chatId: string, userId: string): Promise<Chat> {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) throw new ApiError(404, 'CHAT_NOT_FOUND', '会话不存在');
  return chat;
}

/** 打开会话时加载的最近消息条数；更早的消息按需翻页，避免长会话一次性解密整段历史。 */
const MESSAGE_PAGE_SIZE = 60;

export async function getChatDetail(chatId: string, userId: string): Promise<ChatDetailDto> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    include: {
      provider: { select: { name: true } },
      messages: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MESSAGE_PAGE_SIZE + 1,
        include: { attachments: true }
      }
    }
  });
  if (!chat) throw new ApiError(404, 'CHAT_NOT_FOUND', '会话不存在');
  const hasOlder = chat.messages.length > MESSAGE_PAGE_SIZE;
  return {
    id: chat.id,
    title: decryptChatTitle(chat),
    modelId: chat.modelId,
    providerId: chat.modelProviderId,
    providerName: chat.provider?.name ?? null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: chat.messages.slice(0, MESSAGE_PAGE_SIZE).reverse().map((message) => publicMessage(message)),
    hasOlder
  };
}

/** 向更早翻页：`beforeId` 是当前已加载的最早一条消息。 */
export async function getOlderMessages(
  chatId: string,
  userId: string,
  beforeId: string,
  limit = MESSAGE_PAGE_SIZE
): Promise<{ messages: ChatMessageDto[]; hasOlder: boolean }> {
  await getChatOwned(chatId, userId);
  const cursor = await prisma.message.findFirst({ where: { id: beforeId, chatId }, select: { createdAt: true } });
  if (!cursor) return { messages: [], hasOlder: false };
  const rows = await prisma.message.findMany({
    where: { chatId, createdAt: { lt: cursor.createdAt } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: { attachments: true }
  });
  const hasOlder = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map((message) => publicMessage(message)), hasOlder };
}

export async function renameChat(chatId: string, userId: string, title: string): Promise<ChatSummary[]> {
  const trimmed = title.trim().slice(0, 60);
  if (!trimmed) throw new ApiError(400, 'INVALID_TITLE', '会话标题不能为空');
  await getChatOwned(chatId, userId);
  await prisma.chat.update({
    where: { id: chatId },
    data: { titleCiphertext: encryptString(trimmed, `chat-title:${chatId}`) }
  });
  return listChats(userId);
}

export async function setChatModel(
  chatId: string,
  userId: string,
  provider: AiProvider
): Promise<void> {
  await getChatOwned(chatId, userId);
  await prisma.chat.update({
    where: { id: chatId },
    data: { modelProviderId: provider.id, modelId: provider.modelId }
  });
}

export async function deleteChat(chatId: string, userId: string): Promise<void> {
  await getChatOwned(chatId, userId);
  const attachments = await prisma.attachment.findMany({ where: { chatId, userId } });
  if (attachments.length) {
    await prisma.attachment.deleteMany({ where: { id: { in: attachments.map((a) => a.id) } } });
  }
  await prisma.chat.delete({ where: { id: chatId } });
  const { unlinkAttachmentFile } = await import('./files');
  for (const attachment of attachments) {
    await unlinkAttachmentFile(attachment).catch(() => undefined);
  }
}

export async function deleteAllAttachmentsForUser(userId: string): Promise<number> {
  const attachments = await prisma.attachment.findMany({ where: { userId } });
  for (const attachment of attachments) {
    const { deleteAttachmentAndFile } = await import('./files');
    await deleteAttachmentAndFile(attachment).catch(() => undefined);
  }
  return attachments.length;
}

export async function saveUserMessage(input: {
  chatId: string;
  content: string;
  attachments: Attachment[];
}): Promise<Message> {
  const id = randomUUID();
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        id,
        chatId: input.chatId,
        role: 'USER',
        contentCiphertext: encryptMessage(input.content, id),
        status: 'COMPLETE'
      }
    });
    if (input.attachments.length) {
      const result = await tx.attachment.updateMany({
        where: {
          id: { in: input.attachments.map((a) => a.id) },
          chatId: input.chatId,
          messageId: null
        },
        data: { messageId: id }
      });
      if (result.count !== input.attachments.length) {
        throw new ApiError(400, 'ATTACHMENT_STATE_CHANGED', '附件状态已变化，请重新上传');
      }
    }
    await tx.chat.update({ where: { id: input.chatId }, data: { updatedAt: new Date() } });
    return message;
  });
}

export async function saveAssistantMessage(input: {
  chatId: string;
  content: string;
  providerId: string;
  modelId: string;
  status: 'COMPLETE' | 'PARTIAL' | 'ERROR';
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
}): Promise<Message> {
  const id = randomUUID();
  return prisma.message.create({
    data: {
      id,
      chatId: input.chatId,
      role: 'ASSISTANT',
      contentCiphertext: encryptMessage(input.content, id),
      providerId: input.providerId,
      modelId: input.modelId,
      status: input.status,
      errorCode: input.errorCode?.slice(0, 64) ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null
    }
  });
}

export async function maybeSetGeneratedTitle(chat: Chat, firstUserText: string): Promise<void> {
  const current = decryptChatTitle(chat);
  if (current !== '新对话') return;
  const title = firstUserText
    .replace(/```[\s\S]*?```/g, ' 代码 ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (!title) return;
  await prisma.chat.update({
    where: { id: chat.id },
    data: { titleCiphertext: encryptString(title, `chat-title:${chat.id}`) }
  });
}

export async function buildConversation(input: {
  chatId: string;
  currentContent: string;
  attachments: Attachment[];
  provider: AiProvider;
}): Promise<AiMessage[]> {
  const chat = await prisma.chat.findUnique({
    where: { id: input.chatId },
    select: { id: true }
  });
  if (!chat) throw new ApiError(404, 'CHAT_NOT_FOUND', '会话不存在');
  const historical = await prisma.message.findMany({
    where: { chatId: input.chatId },
    orderBy: { createdAt: 'asc' },
    take: 60
  });
  const trimmed = historical.slice(-40);
  const messages: AiMessage[] = [
    {
      role: 'system',
      content:
        '你是一位可靠、温和的家庭 AI 助手。请使用用户当前使用的语言回答。' +
        '回答应准确、结构清晰；代码使用 Markdown 代码块；数学公式使用 LaTeX。' +
        '如果提供了文档摘录，请优先依据文档内容回答，并明确说明不确定之处。' +
        '不要声称自己看到了未提供的图片或文件。'
    }
  ];

  let charBudget = 40_000;
  for (const message of trimmed) {
    if (message.role === 'SYSTEM') continue;
    const content = decryptMessage(message);
    if (charBudget - content.length < 0) break;
    charBudget -= content.length;
    messages.push({
      role: message.role === 'USER' ? 'user' : 'assistant',
      content
    });
  }

  const capabilities = capabilitiesOf(input.provider);
  const images = input.attachments.filter((a) => a.kind === 'IMAGE');
  const files = input.attachments.filter((a) => a.kind === 'FILE');
  if (images.length && !capabilities.includes('vision')) {
    throw new ApiError(400, 'MODEL_NO_VISION', '当前模型不支持图片输入，请切换支持视觉的模型');
  }
  if (files.length && !capabilities.includes('files')) {
    throw new ApiError(400, 'MODEL_NO_FILES', '当前模型未启用文件理解能力，请切换模型或移除文件');
  }

  let attachmentBlock = '';
  if (files.length) {
    attachmentBlock = buildAttachmentContext(files, input.currentContent);
  }
  const currentText = attachmentBlock
    ? `${input.currentContent}\n\n--- 附件内容（服务器提取） ---\n${attachmentBlock}`
    : input.currentContent;

  const parts: ChatContentPart[] = [{ type: 'text', text: currentText || '（用户上传了附件）' }];
  if (images.length) {
    const urls = await imageDataUrls(images);
    for (const url of urls) parts.push({ type: 'image_url', image_url: { url } });
  }

  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && last.content === input.currentContent) {
    messages[messages.length - 1] = { role: 'user', content: parts };
  } else {
    messages.push({ role: 'user', content: parts });
  }
  return messages;
}

export async function listAttachmentLibrary(userId: string): Promise<PublicAttachment[]> {
  const rows = await prisma.attachment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 500
  });
  return rows.map(publicAttachment);
}

export async function attachmentDebugInfo(attachment: Attachment): Promise<{ name: string; buffer: Buffer }> {
  return { name: attachmentName(attachment), buffer: await readAttachmentBuffer(attachment) };
}
