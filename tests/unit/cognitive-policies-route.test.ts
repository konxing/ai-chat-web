import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 任务书 1.2 要求「所有模块开关必须在服务端执行，不能只依赖前端状态」，1.3 要求用户能查看、
 * 修改、重置策略。这个接口就是那三条要求的落点：没登录读不到也改不了、改的只能是 session
 * 用户自己那个情境的一行、非法情境和非法类型进不了库。审计里只有布尔和枚举，没有对话内容。
 */
const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  authCalls: [] as Array<{ url: string; opts: unknown }>,
  authThrows: false,
  audits: [] as Array<Record<string, unknown>>
}));

function key(userId: string, context: string) {
  return `${userId}|${context}`;
}

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
    memoryPolicy: {
      findMany: ({ where }: { where: { userId: string } }) =>
        Promise.resolve([...db.rows.values()].filter((row) => row.userId === where.userId)),
      upsert: ({
        where,
        create,
        update
      }: {
        where: { userId_context: { userId: string; context: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const id = key(where.userId_context.userId, where.userId_context.context);
        const existing = db.rows.get(id);
        const next = existing ? { ...existing, ...update } : { ...create };
        db.rows.set(id, next);
        return Promise.resolve(next);
      },
      deleteMany: ({ where }: { where: { userId: string; context: string } }) => {
        db.rows.delete(key(where.userId, where.context));
        return Promise.resolve({ count: 1 });
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

const ENDPOINT = 'http://127.0.0.1:3000/api/account/cognitive/policies';

async function call(method: 'GET' | 'PATCH' | 'DELETE', body?: unknown, query = '') {
  const route = await import('@/app/api/account/cognitive/policies/route');
  const request = new Request(`${ENDPOINT}${query}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  // 静态路由没有动态段，Next 只传 request 一个参数。
  const response =
    method === 'GET' ? await route.GET(request) : method === 'PATCH' ? await route.PATCH(request) : await route.DELETE(request);
  return { response, payload: await response.json() };
}

beforeEach(() => {
  db.rows.clear();
  db.authCalls = [];
  db.authThrows = false;
  db.audits = [];
});

describe('记忆策略接口', () => {
  it('未登录时 GET、PATCH、DELETE 全是 401，不落库', async () => {
    db.authThrows = true;

    const get = await call('GET');
    const patch = await call('PATCH', { context: 'general', patch: { allowPersistence: false } });
    const reset = await call('DELETE', undefined, '?context=general');

    expect(get.response.status).toBe(401);
    expect(patch.response.status).toBe(401);
    expect(reset.response.status).toBe(401);
    expect(db.rows.size).toBe(0);
    expect(db.audits).toEqual([]);
  });

  it('PATCH 和 DELETE 都走 requireUser 的默认校验（不关 CSRF）', async () => {
    await call('PATCH', { context: 'general', patch: { allowPersistence: false } });
    await call('DELETE', undefined, '?context=general');

    expect(db.authCalls).toHaveLength(2);
    for (const entry of db.authCalls) expect(entry.opts).toBeUndefined();
  });

  it('GET 返回七个情境的策略，库里没配过时就是内置默认', async () => {
    const { payload } = await call('GET');

    const contexts = Object.keys(payload.data.policies).sort();
    expect(contexts).toEqual([
      'decisionMaking',
      'emotionalSupport',
      'general',
      'learning',
      'personalGoal',
      'personalReflection',
      'technicalProject'
    ]);
    expect(payload.data.policies.emotionalSupport).toMatchObject({
      allowPersistence: false,
      retention: 'sessionOnly'
    });
    expect(payload.data.policies.general).toMatchObject({ allowPersistence: true });
  });

  it('PATCH 只改 session 用户那个情境的一行，请求体里的 userId 不生效', async () => {
    const { payload } = await call('PATCH', {
      userId: 'user-b',
      context: 'emotionalSupport',
      patch: { allowPersistence: true, userId: 'user-b' }
    });

    expect([...db.rows.keys()]).toEqual(['user-a|EMOTIONAL_SUPPORT']);
    expect(db.rows.get('user-a|EMOTIONAL_SUPPORT')).toMatchObject({ userId: 'user-a', allowPersistence: true });
    expect(payload.data.policy.context).toBe('emotionalSupport');
  });

  it('只改提交的那个情境，别的情境不动', async () => {
    await call('PATCH', { context: 'technicalProject', patch: { allowedMemoryTypes: ['fact', 'project'] } });

    const { payload } = await call('GET');

    expect(payload.data.policies.technicalProject.allowedMemoryTypes).toEqual(['fact', 'project']);
    expect(payload.data.policies.general.allowedMemoryTypes).toContain('preference');
    expect(db.rows.size).toBe(1);
  });

  it('非法情境、非法记忆类型和缺字段都被拒，不落库', async () => {
    const badContext = await call('PATCH', { context: 'medical', patch: { allowPersistence: true } });
    const badType = await call('PATCH', { context: 'general', patch: { allowedMemoryTypes: ['salary'] } });
    const noContext = await call('PATCH', { patch: { allowPersistence: true } });
    const badReset = await call('DELETE', undefined, '?context=medical');

    expect(badContext.response.status).toBe(400);
    expect(badContext.payload.error.code).toBe('VALIDATION_ERROR');
    expect(badType.response.status).toBe(400);
    expect(noContext.response.status).toBe(400);
    expect(badReset.response.status).toBe(400);
    expect(db.rows.size).toBe(0);
  });

  it('写进库的情境和类型用数据库的大写枚举，小写只活在外层接口', async () => {
    await call('PATCH', { context: 'general', patch: { allowedMemoryTypes: ['fact', 'goal'] } });

    expect(db.rows.get('user-a|GENERAL')).toMatchObject({ context: 'GENERAL', allowedMemoryTypes: ['FACT', 'GOAL'] });
  });

  it('改策略要留审计，记的是这一个情境改动前后的值', async () => {
    await call('PATCH', { context: 'personalGoal', patch: { retention: 'days30' } });

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorId: 'user-a',
      action: 'user.memory_policy_update',
      targetType: 'user',
      targetId: 'user-a'
    });
    expect(db.audits[0].before).toMatchObject({ context: 'personalGoal', retention: 'forever' });
    expect(db.audits[0].after).toMatchObject({ context: 'personalGoal', retention: 'days30' });
  });

  it('重置＝删掉那一行回到内置默认，同样留审计', async () => {
    await call('PATCH', { context: 'general', patch: { allowUserProfile: false } });
    const { payload } = await call('DELETE', undefined, '?context=general');

    expect(db.rows.size).toBe(0);
    expect(payload.data.policy).toMatchObject({ context: 'general', allowUserProfile: true });
    expect(db.audits).toHaveLength(2);
    expect(db.audits[1]).toMatchObject({ action: 'user.memory_policy_reset' });
    expect(db.audits[1].before).toMatchObject({ allowUserProfile: false });
  });

  it('空补丁和没配过的情境重置，都不产生新审计', async () => {
    await call('PATCH', { context: 'general', patch: {} });
    await call('DELETE', undefined, '?context=learning');

    expect(db.audits).toEqual([]);
  });
});
