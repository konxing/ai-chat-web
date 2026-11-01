import type { AiProvider } from '@prisma/client';
import { FormData as UndiciFormData, File as UndiciFile } from 'undici';
import { ApiError } from './http';
import { decryptProviderKey, capabilitiesOf } from './providers';
import { joinApiPath, resolveProviderTarget, safeFetch } from './ssrf';
import { log } from './logger';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface StreamEvent {
  type: 'delta' | 'usage' | 'done';
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const MAX_OUTPUT_CHARS = 200_000;

/**
 * 整包读取的上限。SSE 分支早就有 2MB 的 buffer 守卫，但 `response.json()` /
 * 错误分支的 `response.text()` 是把对面给的整包吞进内存——而 baseUrl 是管理员
 * 在设置里填的，对面不一定会老实。
 */
const MAX_PROVIDER_BODY_BYTES = 2_000_000;
/** 错误页只取前 800 字符做诊断，读够就撤。 */
const MAX_ERROR_BODY_BYTES = 8_192;

/** 对面回来的包：safeFetch 的返回类型里取，避免和 DOM 的 Response 类型打架。 */
type ProviderResponse = Awaited<ReturnType<typeof safeFetch>>['response'];

async function readBodyCapped(
  response: ProviderResponse,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        return { text, truncated: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已经读完了，取消会报错，忽略 */
    }
    reader.releaseLock();
  }
  return { text, truncated: false };
}

function providerParams(provider: AiProvider): Record<string, unknown> {
  const raw = provider.params;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof obj.temperature === 'number') out.temperature = obj.temperature;
  if (typeof obj.maxTokens === 'number') out.max_tokens = obj.maxTokens;
  return out;
}

function extractTextFromDelta(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function parseUsage(payload: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } {
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return {};
  const u = usage as Record<string, unknown>;
  const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
  return { inputTokens: input, outputTokens: output };
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint and yields text deltas.
 * The provider key is decrypted only in this server-side function and never sent to the client.
 */
export async function* streamChatCompletion(input: {
  provider: AiProvider;
  messages: AiMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): AsyncGenerator<StreamEvent> {
  const { provider } = input;
  if (!capabilitiesOf(provider).includes('text')) {
    throw new ApiError(400, 'MODEL_NO_TEXT', '当前模型不支持文本对话');
  }
  const apiKey = decryptProviderKey(provider);
  const target = await resolveProviderTarget(provider.baseUrl);
  const url = joinApiPath(provider.baseUrl, '/chat/completions');
  const body: Record<string, unknown> = {
    model: provider.modelId,
    messages: input.messages,
    stream: true,
    ...providerParams(provider)
  };

  const safe = await safeFetch(target, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json'
    },
    body: JSON.stringify(body),
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 120_000
  });

  const response = safe.response;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await readBodyCapped(response, MAX_ERROR_BODY_BYTES)).text.slice(0, 800);
    } catch {
      /* ignore */
    }
    await safe.close();
    const sanitized = detail.split(apiKey).join('[redacted]');
    log.warn('ai.provider_error', {
      providerId: provider.id,
      status: response.status,
      detail: sanitized.slice(0, 300)
    });
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, 'AI_AUTH_FAILED', '模型服务认证失败，请检查 API Key');
    }
    if (response.status === 429) {
      throw new ApiError(503, 'AI_RATE_LIMITED', '模型服务限流或额度不足，请稍后重试');
    }
    if (response.status === 404) {
      throw new ApiError(502, 'AI_ENDPOINT_NOT_FOUND', '模型接口不存在，请检查 Base URL 与模型 ID');
    }
    throw new ApiError(502, 'AI_PROVIDER_ERROR', `模型服务返回错误（HTTP ${response.status}）`);
  }

  try {
    if (contentType.includes('application/json')) {
      const { text: raw, truncated } = await readBodyCapped(response, MAX_PROVIDER_BODY_BYTES);
      if (truncated) {
        throw new ApiError(502, 'AI_RESPONSE_TOO_LARGE', '模型返回内容过大');
      }
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const choices = payload.choices as Array<Record<string, unknown>> | undefined;
      const message = choices?.[0]?.message as Record<string, unknown> | undefined;
      const text = extractTextFromDelta(message?.content);
      if (text) yield { type: 'delta', text };
      yield { type: 'usage', ...parseUsage(payload) };
      yield { type: 'done' };
      return;
    }

    if (!response.body) throw new ApiError(502, 'AI_EMPTY_RESPONSE', '模型服务没有返回内容');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let produced = 0;
    let usage: { inputTokens?: number; outputTokens?: number } = {};

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2_000_000) {
          throw new ApiError(502, 'AI_RESPONSE_TOO_LARGE', '模型返回内容过大');
        }
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (!rawLine || rawLine.startsWith(':')) continue;
          if (!rawLine.startsWith('data:')) continue;
          const data = rawLine.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') {
            yield { type: 'usage', ...usage };
            yield { type: 'done' };
            return;
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
          const text = extractTextFromDelta(delta?.content);
          if (text) {
            produced += text.length;
            if (produced > MAX_OUTPUT_CHARS) {
              throw new ApiError(502, 'AI_RESPONSE_TOO_LARGE', '模型返回内容过长，已停止');
            }
            yield { type: 'delta', text };
          }
          if (parsed.usage) usage = { ...usage, ...parseUsage(parsed) };
        }
      }
      if (buffer.startsWith('data:')) {
        const data = buffer.slice(5).trim();
        if (data && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
            const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
            const text = extractTextFromDelta(delta?.content);
            if (text) yield { type: 'delta', text };
            if (parsed.usage) usage = { ...usage, ...parseUsage(parsed) };
          } catch {
            /* ignore trailing partial */
          }
        }
      }
      yield { type: 'usage', ...usage };
      yield { type: 'done' };
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  } finally {
    await safe.close();
  }
}

export async function transcribeAudio(input: {
  provider: AiProvider;
  buffer: Buffer;
  filename: string;
  mime: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (!capabilitiesOf(input.provider).includes('audio')) {
    throw new ApiError(400, 'MODEL_NO_AUDIO', '当前模型不支持语音转写');
  }
  const key = decryptProviderKey(input.provider);
  const target = await resolveProviderTarget(input.provider.baseUrl);
  const url = joinApiPath(input.provider.baseUrl, '/audio/transcriptions');
  const form = new UndiciFormData();
  form.append(
    'file',
    new UndiciFile([new Uint8Array(input.buffer)], input.filename, { type: input.mime })
  );
  form.append('model', input.provider.modelId);
  const safe = await safeFetch(target, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: input.signal,
    timeoutMs: 60_000
  });
  try {
    if (!safe.response.ok) {
      await safe.response.body?.cancel();
      throw new ApiError(502, 'STT_FAILED', `语音转写服务返回 HTTP ${safe.response.status}`);
    }
    const { text: rawBody, truncated } = await readBodyCapped(safe.response, MAX_PROVIDER_BODY_BYTES);
    if (truncated) {
      throw new ApiError(502, 'AI_RESPONSE_TOO_LARGE', '语音转写返回内容过大');
    }
    const data = JSON.parse(rawBody) as { text?: unknown };
    if (typeof data.text !== 'string' || !data.text.trim()) {
      throw new ApiError(502, 'STT_EMPTY', '语音转写没有返回文本');
    }
    return data.text.trim().slice(0, 10_000);
  } finally {
    await safe.close();
  }
}
