import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 开关接口是整个认知引擎的入口，所以它先要保证三件事：没登录什么都改不了、
 * 改的只能是调用者自己的那一行、非法值进不了库。userId 一律取自 session，
 * 请求体里再传一个 userId 也不会被理睬。
 */
const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  authCalls: [] as Array<{ url: string; opts: unknown }>,
  authThrows: false,
  audits: [] as Array<Record<string, unknown>>
}));

// 工厂里现取 ApiError：这样抛出的实例和路由里 instanceof 用的是同一个类。
vi.mock('@/lib/auth', async () => {
  const { ApiError } = await import('@/lib/http');
  return {
    requireUser: (req: Request, opts?: unknown) => {
      db.authCalls.push({ url: req.url, opts });
      if (db.authThrows) return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', '请先登录'));
      return Promise.resolve({ user: { id: 'user-a', username: 'konxing' }, session: { id: 'sess-1' } });
    }
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cognitivePreference: {
      findUnique: ({ where }: { where: { userId: string } }) =>
        Promise.resolve((db.rows.get(where.userId) as object | undefined) ?? null),
      upsert: ({ where, create, update }: { where: { userId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = db.rows.get(where.userId);
        const next = existing ? { ...existing, ...update } : { ...create };
        db.rows.set(where.userId, next);
        return Promise.resolve(next);
      }
    },
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        db.audits.push(data);
        return Promise.resolve(data);
      }
    }
  }
}));

const ENDPOINT = 'http://127.0.0.1:3000/api/account/cognitive';

async function call(method: string, body?: unknown) {
  const route = await import('@/app/api/account/cognitive/route');
  const request = new Request(ENDPOINT, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  // 静态路由没有动态段，Next 只传 request 一个参数。
  const response = method === 'GET' ? await route.GET(request) : await route.PATCH(request);
  return { response, payload: await response.json() };
}

beforeEach(() => {
  db.rows.clear();
  db.authCalls = [];
  db.authThrows = false;
  db.audits = [];
});

describe('认知开关接口', () => {
  it('未登录时 GET 和 PATCH 都是 401，不落库', async () => {
    db.authThrows = true;

    const get = await call('GET');
    const patch = await call('PATCH', { memoryEnabled: true });

    expect(get.response.status).toBe(401);
    expect(get.payload.error.code).toBe('UNAUTHENTICATED');
    expect(patch.response.status).toBe(401);
    expect(db.rows.size).toBe(0);
  });

  it('PATCH 走 requireUser 的默认校验（不关 CSRF）', async () => {
    const { response } = await call('PATCH', { memoryEnabled: true });

    expect(response.status).toBe(200);
    expect(db.authCalls).toHaveLength(1);
    expect(db.authCalls[0].opts).toBeUndefined();
  });

  it('GET 返回全部八个开关，库里没记录时全是默认关闭', async () => {
    const { payload } = await call('GET');

    expect(payload.data.preferences).toEqual({
      memoryEnabled: false,
      userModelEnabled: false,
      emotionEnabled: false,
      associationEnabled: false,
      timelineEnabled: false,
      reflectionEnabled: false,
      decisionMemoryEnabled: false,
      adaptiveMemoryEnabled: false,
      emotionTransparency: 'implicit'
    });
  });

  it('PATCH 只改 session 用户那一行，请求体里的 userId 不生效', async () => {
    await call('PATCH', { memoryEnabled: true });

    expect(db.rows.has('user-a')).toBe(true);
    expect([...db.rows.keys()]).toEqual(['user-a']);
  });

  it('非法的透明度值被拒，且不写库', async () => {
    const { response, payload } = await call('PATCH', { emotionTransparency: 'always' });

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(db.rows.size).toBe(0);
  });

  it('空补丁不改变任何东西', async () => {
    await call('PATCH', { userModelEnabled: true });

    const { response } = await call('PATCH', {});

    expect(response.status).toBe(200);
    expect(db.rows.get('user-a')).toMatchObject({ userModelEnabled: true, memoryEnabled: false });
  });

  it('写进库的透明度用数据库的大写枚举，小写只活在外层接口', async () => {
    await call('PATCH', { emotionTransparency: 'explicit' });

    expect(db.rows.get('user-a')?.emotionTransparency).toBe('EXPLICIT');
  });

  it('改开关要留审计，记的是 session 用户和改动前后的值', async () => {
    await call('PATCH', { memoryEnabled: true });

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorId: 'user-a',
      action: 'user.cognitive_update',
      targetType: 'user',
      targetId: 'user-a'
    });
    expect(db.audits[0].before).toMatchObject({ memoryEnabled: false });
    expect(db.audits[0].after).toMatchObject({ memoryEnabled: true });
  });

  it('空补丁不产生审计记录', async () => {
    await call('PATCH', {});

    expect(db.audits).toEqual([]);
  });
});
