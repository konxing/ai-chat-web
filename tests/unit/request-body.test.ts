import { describe, expect, it } from 'vitest';
import { ApiError, assertSameOrigin, readJson, readMultipartLimited } from '@/lib/http';

// Node 的 fetch 实现要求流式请求体声明 duplex，DOM 类型里没有这个字段。
type BodyRequestInit = RequestInit & { duplex?: 'half' };

function jsonRequest(
  body: BodyInit | null,
  url = 'http://127.0.0.1:3000/api/chats/c1/messages',
  headers: Record<string, string> = {}
) {
  const init: BodyRequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  };
  if (body instanceof ReadableStream) {
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function withOrigin(origin: string, url = 'http://127.0.0.1:3000/api/chats/c1/messages') {
  return assertSameOrigin(new Request(url, { method: 'POST', headers: { origin } }));
}

function streamOf(text: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 16));
      offset += 16;
    }
  });
}

function expectApiError(run: () => Promise<unknown>, status: number, code: string) {
  return run().then(
    () => {
      throw new Error('expected ApiError');
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      expect((err as ApiError).code).toBe(code);
    }
  );
}

describe('同源校验', () => {
  const APP_URL = process.env.APP_URL as string;

  it('放行 APP_URL 声明的入口', () => {
    expect(() => withOrigin(APP_URL)).not.toThrow();
  });

  it('放行 ALLOWED_ORIGINS 追加的入口', () => {
    process.env.ALLOWED_ORIGINS = 'http://192.168.1.5:3000, https://chat.example.com';
    try {
      expect(() => withOrigin('http://192.168.1.5:3000', 'http://192.168.1.5:3000/api/chats')).not.toThrow();
      expect(() => withOrigin('https://chat.example.com', 'https://chat.example.com/api/chats')).not.toThrow();
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it('不认请求自带的 Host：重绑定过来的同源请求照样被挡', () => {
    expect(() =>
      withOrigin('http://rebind.example:3000', 'http://rebind.example:3000/api/chats')
    ).toThrowError(/来源/);
  });

  it('跨站来源与同主机不同端口都被挡住', () => {
    expect(() => withOrigin('https://evil.example')).toThrowError(ApiError);
    expect(() => withOrigin('http://localhost:3000')).toThrowError(/来源/);
  });

  it('无 Origin 头时交给 CSRF token 与 SameSite 处理', () => {
    expect(() => assertSameOrigin(jsonRequest('{}'))).not.toThrow();
  });

  it('APP_URL 与 ALLOWED_ORIGINS 都无效时报配置错误，不静默放行', () => {
    process.env.APP_URL = 'not-a-url';
    delete process.env.ALLOWED_ORIGINS;
    try {
      expect(() => withOrigin('http://127.0.0.1:3000')).toThrowError(/配置无效/);
    } finally {
      process.env.APP_URL = APP_URL;
    }
  });
});

describe('请求体体积上限', () => {
  it('正常 JSON 可以读取', async () => {
    await expect(readJson(jsonRequest('{"content":"你好"}'))).resolves.toEqual({ content: '你好' });
  });

  it('声明的 content-length 超限直接拒绝，不读主体', async () => {
    await expectApiError(
      () => readJson(jsonRequest(streamOf('{"a":1}'), undefined, { 'content-length': '5000' }), 10),
      413,
      'PAYLOAD_TOO_LARGE'
    );
  });

  it('content-length 撒谎时按实际字节数拦下', async () => {
    const lying = jsonRequest(streamOf('{"a":"' + 'x'.repeat(4000) + '"}'), undefined, {
      'content-length': '8'
    });
    await expectApiError(() => readJson(lying, 100), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('非 JSON 内容类型被拒绝', async () => {
    await expectApiError(
      () => readJson(new Request('http://127.0.0.1:3000/api/chats', { method: 'POST', body: 'x' })),
      415,
      'UNSUPPORTED_MEDIA_TYPE'
    );
  });

  it('无效 JSON 报格式错误', async () => {
    await expectApiError(() => readJson(jsonRequest('{oops')), 400, 'INVALID_JSON');
  });

  it('multipart 超限按实际字节数拒绝', async () => {
    const boundary = '----vitestboundary';
    const payload =
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.txt"\r\n\r\n` +
      'x'.repeat(4000) +
      `\r\n--${boundary}--\r\n`;
    const init: BodyRequestInit = {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': '8'
      },
      body: streamOf(payload),
      duplex: 'half'
    };
    const req = new Request('http://127.0.0.1:3000/api/attachments', init);
    await expectApiError(() => readMultipartLimited(req, 200), 413, 'FILE_TOO_LARGE');
  });

  it('multipart 在上限内可正常解析', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    const req = new Request('http://127.0.0.1:3000/api/attachments', { method: 'POST', body: form });
    const parsed = await readMultipartLimited(req, 100_000);
    expect(parsed.get('file')).toBeInstanceOf(File);
  });
});
