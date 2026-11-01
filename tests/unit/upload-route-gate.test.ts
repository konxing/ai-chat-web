import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 上传路由是内存压力最大的入口：一次上传会在进程里留下「表单整包 + File + Buffer +
 * 加密输出」几份副本。这里钉住两道闸——限流窗口放宽到 120/分钟（批量传图不该被掐），
 * 但同时只允许一个上传真正在落盘，第 4 个并发请求直接拒绝，不让副本数量继续叠。
 */
const ctx = vi.hoisted(() => ({
  storeMode: 'instant' as 'instant' | 'hold',
  storeResolvers: [] as Array<() => void>,
  storedFilenames: [] as string[]
}));

vi.mock('@/lib/auth', () => ({
  requireUser: () => Promise.resolve({ user: { id: 'user-1' }, isAdmin: false })
}));

vi.mock('@/lib/chats', () => ({
  getChatOwned: () => Promise.resolve({ id: 'chat-1', userId: 'user-1' })
}));

vi.mock('@/lib/files', () => ({
  maxUploadBytes: () => Promise.resolve(300 * 1024 * 1024),
  storeUpload: (input: { filename: string }) => {
    ctx.storedFilenames.push(input.filename);
    if (ctx.storeMode === 'instant') return Promise.resolve({ id: 'att-1', filename: input.filename });
    return new Promise((resolve) => {
      ctx.storeResolvers.push(() => resolve({ id: 'att-1', filename: input.filename }));
    });
  },
  publicAttachment: (attachment: { filename: string }) => attachment
}));

const MB = 1024 * 1024;

function formRequest(filename: string): Request {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], filename, { type: 'image/png' }));
  form.append('chatId', 'chat-1');
  return new Request('http://localhost/api/upload', { method: 'POST', body: form });
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 限流桶和串行闸都是模块级状态，每个用例换一份全新的路由与依赖。 */
async function loadRoute() {
  vi.resetModules();
  const route = await import('@/app/api/upload/route');
  const { resetRateLimitForTests } = await import('@/lib/rate-limit');
  resetRateLimitForTests();
  ctx.storeMode = 'instant';
  ctx.storeResolvers = [];
  ctx.storedFilenames = [];
  return route;
}

async function post(route: { POST: (req: Request) => Promise<Response> }, filename: string) {
  const response = await route.POST(formRequest(filename));
  await response.json();
  return response;
}

describe('上传路由的限流窗口', () => {
  beforeEach(() => {
    ctx.storeMode = 'instant';
    ctx.storeResolvers = [];
    ctx.storedFilenames = [];
  });

  it('连传 120 次都在窗口内放行，第 121 次才被限流', async () => {
    const route = await loadRoute();

    const statuses: number[] = [];
    for (let i = 0; i < 120; i++) {
      const response = await post(route, `pic-${i}.png`);
      statuses.push(response.status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(ctx.storedFilenames).toHaveLength(120);

    const rejected = await route.POST(formRequest('pic-121.png'));
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).error.message).toBe('上传过于频繁，请稍后再试');
    expect(ctx.storedFilenames).toHaveLength(120);
  });
});

describe('上传路由的并发闸', () => {
  it('3 个并发上传排队落盘，第 4 个被拒且不会碰到磁盘', async () => {
    const route = await loadRoute();
    ctx.storeMode = 'hold';

    const inflight = [
      route.POST(formRequest('a.png')),
      route.POST(formRequest('b.png')),
      route.POST(formRequest('c.png'))
    ];
    await tick();
    await tick();
    expect(ctx.storeResolvers).toHaveLength(1);

    const fourth = await route.POST(formRequest('d.png'));
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).error.message).toBe('正在处理其他上传，请稍后再试');
    expect(ctx.storedFilenames).toEqual(['a.png']);

    for (let i = 0; i < 8 && ctx.storeResolvers.length; i++) {
      ctx.storeResolvers.shift()?.();
      await tick();
    }

    const responses = await Promise.all(inflight);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(ctx.storedFilenames).toEqual(['a.png', 'b.png', 'c.png']);
  });
});
