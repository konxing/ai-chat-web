import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiProvider } from '@prisma/client';
import { ApiError } from '@/lib/http';
import { resetEnvCacheForTests } from '@/lib/env';
import { encryptString } from '@/lib/crypto';
import { streamChatCompletion, transcribeAudio } from '@/lib/ai';

/**
 * 模型返回体的体积上限。SSE 分支早就有 2MB 的 buffer 守卫，但另外三条读整包的路径没有：
 * 非流式 JSON 分支的 `response.json()`、语音转写的 `response.json()`、以及错误分支的
 * `response.text()`——而 baseUrl 是用户可在设置里填的。这里用真的本地服务把它们打回原形：
 * 一个 6MB 的合法 JSON 不许被整包吞进内存再解析。
 */
let server: http.Server;
let origin = '';

const HUGE_TEXT = 'x'.repeat(6_000_000);

function provider(pathTag: string, capabilities: string[]): AiProvider {
  const id = `probe-${pathTag}`;
  return {
    id,
    ownerType: 'GLOBAL',
    userId: null,
    name: '本地探针',
    baseUrl: `${origin}/${pathTag}`,
    modelId: 'probe-model',
    capabilities,
    params: {},
    apiKeyCiphertext: encryptString('sk-probe', `provider-key:${id}`),
    enabled: true,
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date()
  } as unknown as AiProvider;
}

async function drain(gen: AsyncGenerator<{ type: string; text?: string }>): Promise<string> {
  let out = '';
  for await (const event of gen) {
    if (event.type === 'delta') out += event.text ?? '';
  }
  return out;
}

beforeAll(async () => {
  process.env.ALLOW_PRIVATE_AI_URLS = 'true';
  resetEnvCacheForTests();

  server = http.createServer((req, res) => {
    req.resume();
    const path = req.url || '';
    const respond = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
      res.on('error', () => undefined);
    };
    if (path.startsWith('/fat/chat/completions')) {
      // 合法 JSON，只是巨大：不设上限的实现会整包读进内存并成功解析出 6M 字符。
      respond(200, 'application/json', JSON.stringify({ choices: [{ message: { content: HUGE_TEXT } }] }));
      return;
    }
    if (path.startsWith('/ok/chat/completions')) {
      respond(
        200,
        'application/json',
        JSON.stringify({ choices: [{ message: { content: '你好' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
      );
      return;
    }
    if (path.startsWith('/boom/chat/completions')) {
      respond(500, 'text/plain', `服务内部错误 ${'y'.repeat(1_000_000)}`);
      return;
    }
    if (path.startsWith('/fat/audio/transcriptions')) {
      respond(200, 'application/json', JSON.stringify({ text: HUGE_TEXT }));
      return;
    }
    respond(404, 'text/plain', 'no route');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env.ALLOW_PRIVATE_AI_URLS = 'false';
  resetEnvCacheForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('模型返回体的体积上限', () => {
  it('非流式 JSON 超过上限时报错，而不是整包吞下', async () => {
    let caught: unknown;
    try {
      const text = await drain(streamChatCompletion({ provider: provider('fat', ['text']), messages: [{ role: 'user', content: 'hi' }] }));
      caught = `no error, got ${text.length} chars`;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('AI_RESPONSE_TOO_LARGE');
  });

  it('小体积的非流式 JSON 照常出字与用量', async () => {
    const events: string[] = [];
    let text = '';
    for await (const event of streamChatCompletion({ provider: provider('ok', ['text']), messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event.type);
      if (event.type === 'delta') text += event.text ?? '';
    }
    expect(text).toBe('你好');
    expect(events).toEqual(['delta', 'usage', 'done']);
  });

  it('HTTP 错误 + 1MB 错误页仍然映射成原来的模型服务错误', async () => {
    let caught: unknown;
    try {
      await drain(streamChatCompletion({ provider: provider('boom', ['text']), messages: [{ role: 'user', content: 'hi' }] }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('AI_PROVIDER_ERROR');
  });

  it('语音转写的整包 JSON 同样有上限', async () => {
    let caught: unknown;
    try {
      const text = await transcribeAudio({ provider: provider('fat', ['text', 'audio']), buffer: Buffer.from('audio'), filename: 'a.wav', mime: 'audio/wav' });
      caught = `no error, got ${text.length} chars`;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('AI_RESPONSE_TOO_LARGE');
  });
});
