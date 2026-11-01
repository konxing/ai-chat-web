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
  getChatOwned,
  getOlderMessages,
  publicMessage,
  saveAssistantMessage,
  saveUserMessage
} from '@/lib/chats';
import { getAttachmentsForUser, publicAttachment } from '@/lib/files';
import { capabilitiesOf, getProviderForUser, resolveDefaultProvider } from '@/lib/providers';
import { streamChatCompletion } from '@/lib/ai';
import { log } from '@/lib/logger';
import { writeAudit } from '@/lib/audit';

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

  const userMessage = await saveUserMessage({
    chat,
    content: body.content,
    attachments,
    providerId: provider.id,
    modelId: provider.modelId
  });
  const messages = await buildConversation({
    chatId,
    userId: user.id,
    currentContent: body.content,
    attachments,
    provider
  });

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener('abort', onAbort);
  // 客户端可能在挂监听之前就已经断开，那种情况下 abort 事件永远不会再来：
  // 不补这一刀，这一轮会冲着一条不存在的连接把模型调用跑完。
  if (req.signal.aborted) abort.abort();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let content = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      // 审计问的是「这一轮发生过什么」，不是「模型有没有自己说 done」：
      // 以 done 事件为闸门时，失败、取消、以及没发 done 就结束的轮次在审计里完全不存在。
      let outcome: 'SUCCESS' | 'FAILURE' | 'ABORTED' = 'SUCCESS';
      let failureCode: string | undefined;
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        for await (const event of streamChatCompletion({
          provider,
          messages,
          signal: abort.signal
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
          modelId: provider.modelId
        });
        controller.close();
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '模型调用失败，请稍后重试';
        const code = err instanceof ApiError ? err.code : 'AI_ERROR';
        log.warn('chat.stream_failed', {
          chatId,
          providerId: provider.id,
          code,
          error: err instanceof Error ? err.message : String(err)
        });
        if (abort.signal.aborted && !content) {
          outcome = 'ABORTED';
          failureCode = 'ABORTED';
          controller.close();
          return;
        }
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
        controller.close();
      } finally {
        req.signal.removeEventListener('abort', onAbort);
        writeAudit({
          actorId: user.id,
          actorLabel: user.username,
          action: 'chat.message',
          targetType: 'chat',
          targetId: chatId,
          ip: getRequestIp(req),
          userAgent: getUserAgent(req),
          after: { providerId: provider.id, modelId: provider.modelId, chars: content.length, outcome },
          status: outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
          error: failureCode ?? null
        }).catch(() => undefined);
      }
    },
    cancel() {
      abort.abort();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
