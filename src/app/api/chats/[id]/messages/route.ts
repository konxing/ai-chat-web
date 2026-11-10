import {
  api,
  ApiError,
  getRequestIp,
  getUserAgent,
  jsonError,
  readJson
} from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { sendMessageSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import {
  buildConversation,
  encryptMessage,
  getChatOwned,
  getOlderMessages,
  publicMessage,
  saveAssistantMessage,
  saveUserMessage
} from '@/lib/chats';
import { prisma } from '@/lib/prisma';
import { getAttachmentsForUser, imageSendSummary, publicAttachment } from '@/lib/files';
import { capabilitiesOf, getProviderForUser, resolveDefaultProvider } from '@/lib/providers';
import { streamChatCompletion } from '@/lib/ai';
import { log } from '@/lib/logger';
import { writeAudit } from '@/lib/audit';
import { recordMemoryAccess } from '@/lib/cognitive/access';
import { enqueueCognitiveTask } from '@/lib/cognitive/task-queue';
import { conversationLayerEnabled } from '@/lib/cognitive/cognitive-flags';
import { learnConversationPreference } from '@/lib/cognitive/conversation/learning/preference-extractor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(() => handleChatPost(req, ctx));
}

/** 向更早翻页：GET /api/chats/:id/messages?before=<最早一条消息 id> */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const before = new URL(req.url).searchParams.get('before');
    if (!before) throw new ApiError(400, 'MISSING_CURSOR', '缺少分页游标');
    return getOlderMessages(id, user.id, before);
  });
}

async function handleChatPost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { user } = await requireUser(req);
  const { id: chatId } = await ctx.params;
  const limit = rateLimit(`chat:${user.id}`, 30, 60 * 1000);
  if (!limit.ok) return jsonError(429, 'RATE_LIMITED', '发送过于频繁，请稍后再试');
  const body = sendMessageSchema.parse(await readJson(req));
  if (!body.content.trim() && body.attachmentIds.length === 0) {
    throw new ApiError(400, 'EMPTY_MESSAGE', '消息内容不能为空');
  }

  const chat = await getChatOwned(chatId, user.id);
  let provider;
  if (chat.modelProviderId) {
    try {
      provider = await getProviderForUser(chat.modelProviderId, user.id);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'MODEL_NOT_FOUND') throw err;
    }
  }
  if (!provider) provider = await resolveDefaultProvider(user.id);

  const attachments = await getAttachmentsForUser(body.attachmentIds, user.id, chatId);
  const caps = capabilitiesOf(provider);
  if (attachments.some((a) => a.kind === 'IMAGE') && !caps.includes('vision')) {
    throw new ApiError(400, 'MODEL_NO_VISION', '当前模型不支持图片输入，请切换支持视觉的模型');
  }
  if (attachments.some((a) => a.kind === 'FILE') && !caps.includes('files')) {
    throw new ApiError(400, 'MODEL_NO_FILES', '当前模型未启用文件理解能力，请切换模型或移除文件');
  }

  let userMessage: Awaited<ReturnType<typeof saveUserMessage>>;
  if (body.editMessageId) {
    // 编辑=重发：更新该用户消息，移除其后所有问答（含其附件），再走同一条流式重答链路。
    const target = await prisma.message.findFirst({
      where: { id: body.editMessageId, chatId, role: 'USER' }
    });
    if (!target) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '要编辑的消息不存在');
    userMessage = await prisma.$transaction(async (tx) => {
      const removed = await tx.message.findMany({
        where: { chatId, createdAt: { gt: target.createdAt } },
        select: { id: true }
      });
      if (removed.length) {
        await tx.attachment.deleteMany({ where: { messageId: { in: removed.map((r) => r.id) } } });
        await tx.message.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
      }
      const updated = await tx.message.update({
        where: { id: target.id },
        data: { contentCiphertext: encryptMessage(body.content, target.id), status: 'COMPLETE' }
      });
      if (attachments.length) {
        const result = await tx.attachment.updateMany({
          where: { id: { in: attachments.map((a) => a.id) }, chatId, messageId: null },
          data: { messageId: target.id }
        });
        if (result.count !== attachments.length) {
          throw new ApiError(400, 'ATTACHMENT_STATE_CHANGED', '附件状态已变化，请重新上传');
        }
      }
      return updated;
    });
  } else {
    userMessage = await saveUserMessage({
      chat,
      content: body.content,
      attachments,
      providerId: provider.id,
      modelId: provider.modelId
    });
  }
  const { messages, citedMemoryIds, cognitiveFailed } = await buildConversation({
    chatId,
    userId: user.id,
    currentContent: body.content,
    attachments,
    provider
  });
  // 挂 15 张和发得出去 4 张是两个数：超出的部分这轮不进模型，不说明用户只会觉得模型没看图。
  const imageSummary = imageSendSummary(attachments);

  // 客户端切走（去后台、关页面）不再中断这一轮：模型照常生成、落库、积记忆，用户回来能看到
  // 完整回答。断开只是「不再往这条连接写字节」，不是「这轮不该发生」。模型调用自身有 120s
  // 超时兜底（ai.ts），不会因为没人看就无限跑。
  let clientGone = req.signal.aborted;
  const markGone = () => {
    clientGone = true;
  };
  req.signal.addEventListener('abort', markGone);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let content = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      // 审计问的是「这一轮发生过什么」，不是「模型有没有自己说 done」：
      // 以 done 事件为闸门时，失败、取消、以及没发 done 就结束的轮次在审计里完全不存在。
      let outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS';
      let failureCode: string | undefined;
      const send = (payload: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // 连接已取消：剩下的字节无处可去，但生成和落库照常走完。
          clientGone = true;
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* 已关闭或已取消 */
        }
      };

      try {
        for await (const event of streamChatCompletion({
          provider,
          messages
        })) {
          if (event.type === 'delta' && event.text) {
            content += event.text;
            send({ type: 'delta', text: event.text });
          } else if (event.type === 'usage') {
            inputTokens = event.inputTokens ?? inputTokens;
            outputTokens = event.outputTokens ?? outputTokens;
            if (inputTokens !== undefined || outputTokens !== undefined) {
              send({ type: 'usage', inputTokens, outputTokens });
            }
          }
        }

        const saved = await saveAssistantMessage({
          chatId,
          content: content || '（模型没有返回文本）',
          providerId: provider.id,
          modelId: provider.modelId,
          status: 'COMPLETE',
          inputTokens,
          outputTokens
        });
        send({
          type: 'done',
          message: publicMessage(saved),
          userMessage: publicMessage(userMessage),
          providerId: provider.id,
          providerName: provider.name,
          modelId: provider.modelId,
          imagesSent: imageSummary.sent,
          imagesSkipped: imageSummary.skipped,
          // 引用清单（任务书 8.2）：这一轮真的进了提示词的那几条记忆 id。
          // 只在成功帧里给——失败和中断的那一帧用户看到的是错误文案，不是一句「引用了什么」。
          memoryIds: citedMemoryIds
        });
        close();
        // 字节已经全部交给客户端，才欠下这一轮的记忆：认知模块不在关键路径上，
        // 慢或者坏都不影响这轮回答。只有成功回答的轮次才欠账，失败和取消的轮次不留记忆。
        //
        // 落库而不是当场跑——原来那句 `void queueCognitiveWrites(...)` 挂在请求尾巴上，
        // 进程在这中间被杀掉，这一轮的记忆就永久丢了。现在它是一条欠账，worker 跑不完就还在。
        // await 而不 void 是因为 enqueueCognitiveTask 自己不 reject（写失败只记日志），
        // 而这一刻流已经关了，等一次 insert 的代价只落在审计上。
        await enqueueCognitiveTask({
          userId: user.id,
          chatId,
          sourceMessageId: userMessage.id,
          kind: 'MEMORY'
        });
        // 同一时刻记下「这一轮真的带了哪几条记忆进提示词」（任务书 7.1 的那次调用）。
        // 和上面那条欠账一样：只有答完的轮次才记，写在 close() 之后，自己不抛（access.ts），
        // 而且只有 id。没带记忆就不写行，那个判断在 recordMemoryAccess 里。
        await recordMemoryAccess({
          userId: user.id,
          sourceMessageId: userMessage.id,
          memoryIds: citedMemoryIds
        });
        // 对话智能层 Phase 6：从用户这轮的明确表达反馈学习长期风格（仅 GLOBAL 持久化）。
        // 异步、不阻塞、失败静默；开关关着时一次都不跑。
        if (await conversationLayerEnabled().catch(() => false)) {
          void learnConversationPreference(user.id, content).catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '模型调用失败，请稍后重试';
        const code = err instanceof ApiError ? err.code : 'AI_ERROR';
        log.warn('chat.stream_failed', {
          chatId,
          providerId: provider.id,
          code,
          error: err instanceof Error ? err.message : String(err)
        });
        outcome = 'FAILURE';
        failureCode = code;
        try {
          if (content) {
            const saved = await saveAssistantMessage({
              chatId,
              content,
              providerId: provider.id,
              modelId: provider.modelId,
              status: 'PARTIAL',
              inputTokens,
              outputTokens,
              errorCode: code
            });
            send({ type: 'partial', message: publicMessage(saved), error: { code, message } });
          } else {
            // 一个字都没拿到也留一条记录：否则刷新之后历史里只剩用户那句孤零零的提问，
            // 看不出这一轮问过、也看不出它失败了。这条行不进模型上下文
            // （buildConversation 排除 ERROR），前端沿用原有的 error 事件 + 随后的重取。
            await saveAssistantMessage({
              chatId,
              content: message,
              providerId: provider.id,
              modelId: provider.modelId,
              status: 'ERROR',
              inputTokens,
              outputTokens,
              errorCode: code
            });
            send({ type: 'error', error: { code, message } });
          }
        } catch (saveErr) {
          log.error('chat.partial_save_failed', { error: String(saveErr) });
          send({ type: 'error', error: { code, message } });
        }
        close();
      } finally {
        req.signal.removeEventListener('abort', markGone);
        writeAudit({
          actorId: user.id,
          actorLabel: user.username,
          action: 'chat.message',
          targetType: 'chat',
          targetId: chatId,
          ip: getRequestIp(req),
          userAgent: getUserAgent(req),
          after: {
            providerId: provider.id,
            modelId: provider.modelId,
            chars: content.length,
            outcome,
            cognitiveFailed
          },
          status: outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
          error: failureCode ?? null
        }).catch(() => undefined);
      }
    },
    cancel() {
      // 客户端取消只停写字节，生成照常走完（见 start 里的 clientGone）。
      markGone();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
