import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 排除规则的接口（任务书 7.3）。只有两个动词：看有哪些内容不会再被自动记住，以及撤销一条。
 *
 * 撤销入口不是可选的装饰：一条没有任何界面能解开的静默永久封禁，比假开关更糟——
 * 用户会发现自己说过的话 AI 再也记不住，而且不知道为什么。
 *
 * @/lib/cognitive/exclusions 在这里是 mock 的：HMAC、密文、上限淘汰都在
 * cognitive-exclusions.test.ts 里测过，这里钉的是路由自己那层——身份从哪来、
 * 404 怎么映射、限流挡在哪一步、审计里有没有正文。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  limiterOk: true,
  limiterCalls: [] as Array<{ key: string; limit: number; windowMs: number }>,
  listCalls: [] as string[],
  removeCalls: [] as Array<{ id: string; userId: string }>,
  removeResult: true,
  audits: [] as Array<Record<string, unknown>>,
  rows: [
    {
      id: 'exc-1',
      content: '我住在杭州',
      chatId: 'chat-1',
      sourceMessageId: 'msg-1',
      createdAt: '2026-11-02T10:00:00.000Z'
    }
  ] as Array<Record<string, unknown>>
}));

vi.mock('@/lib/auth', async () => {
  const { ApiError } = await import('@/lib/http');
  return {
    requireUser: () =>
      db.authThrows
        ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', '请先登录'))
        : Promise.resolve({ user: { id: 'user-a', username: 'konxing' }, session: { id: 'sess-1' } })
  };
});

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (key: string, limit: number, windowMs: number) => {
    db.limiterCalls.push({ key, limit, windowMs });
    return { ok: db.limiterOk, remaining: 5, retryAfterSec: 42, limit };
  }
}));

vi.mock('@/lib/audit', () => ({
  writeAudit: (input: Record<string, unknown>) => {
    db.audits.push(input);
    return Promise.resolve();
  }
}));

vi.mock('@/lib/cognitive/exclusions', () => ({
  listExclusions: (userId: string) => {
    db.listCalls.push(userId);
    return Promise.resolve(db.rows);
  },
  removeExclusion: (id: string, userId: string) => {
    db.removeCalls.push({ id, userId });
    return Promise.resolve(db.removeResult);
  }
}));

const BASE = 'http://127.0.0.1:3000/api/account/cognitive/exclusions';

async function call(method: 'GET' | 'DELETE', path = '') {
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' }
  });
  const route =
    path === ''
      ? await import('@/app/api/account/cognitive/exclusions/route')
      : await import('@/app/api/account/cognitive/exclusions/[id]/route');
  const ctx = path === '' ? {} : { params: Promise.resolve({ id: path.slice(1) }) };
  const handlers = route as unknown as Record<string, (req: Request, ctx?: unknown) => Promise<Response>>;
  const response = await handlers[method](request, ctx);
  return { response, payload: await response.json() };
}

beforeEach(() => {
  db.authThrows = false;
  db.limiterOk = true;
  db.limiterCalls = [];
  db.listCalls = [];
  db.removeCalls = [];
  db.removeResult = true;
  db.audits = [];
});

describe('读：哪些内容不会再被自动记住', () => {
  it('未登录时 401，一次查询都不发', async () => {
    db.authThrows = true;

    const { response } = await call('GET');

    expect(response.status).toBe(401);
    expect(db.listCalls).toEqual([]);
  });

  it('登录后返回自己的排除列表，正文是解密后的明文', async () => {
    const { response, payload } = await call('GET');

    expect(response.status).toBe(200);
    expect(payload.data.exclusions).toEqual(db.rows);
    expect(db.listCalls).toEqual(['user-a']);
  });
});

describe('撤销一条排除', () => {
  it('撤销自己的排除，返回结果并写审计', async () => {
    const { response, payload } = await call('DELETE', '/exc-1');

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({ removed: true });
    expect(db.removeCalls).toEqual([{ id: 'exc-1', userId: 'user-a' }]);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: 'user.memory_exclusion_remove',
      targetType: 'memory_exclusion',
      targetId: 'exc-1',
      actorId: 'user-a'
    });
  });

  it('审计里不出现被排除的正文', async () => {
    await call('DELETE', '/exc-1');

    expect(JSON.stringify(db.audits[0])).not.toContain('我住在杭州');
  });

  it('撤销别人的或已经不存在的排除返回 404，不写审计', async () => {
    db.removeResult = false;

    const { response, payload } = await call('DELETE', '/exc-9');

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('EXCLUSION_NOT_FOUND');
    expect(db.removeCalls).toEqual([{ id: 'exc-9', userId: 'user-a' }]);
    expect(db.audits).toEqual([]);
  });

  it('未登录时 401，不删也不写审计', async () => {
    db.authThrows = true;

    const { response } = await call('DELETE', '/exc-1');

    expect(response.status).toBe(401);
    expect(db.removeCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('触发限流时 429，删除和审计都不发', async () => {
    db.limiterOk = false;

    const { response, payload } = await call('DELETE', '/exc-1');

    expect(response.status).toBe(429);
    expect(payload.error.code).toBe('RATE_LIMITED');
    expect(db.removeCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('限流桶按 session 用户分，不认路径里的东西', async () => {
    await call('DELETE', '/exc-1');

    expect(db.limiterCalls[0].key).toBe('memory-exclusion-remove:user-a');
  });
});
