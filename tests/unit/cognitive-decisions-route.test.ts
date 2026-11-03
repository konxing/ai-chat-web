import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/account/decisions/route';
import { PATCH } from '@/app/api/account/decisions/[id]/route';

/**
 * 决策接口（任务书 5.5 的后端）。钉路由层的三个决定：
 * 一、身份只来自 session；
 * 二、decisionMemoryEnabled 关掉时 GET 和 PATCH 都**一次服务层调用都不发**（门槛 9）；
 * 三、确认/拒绝的动词只能来自白名单，别的 body 是 400 不是 500。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  enabled: false,
  preferencesThrows: false,
  listCalls: [] as Array<{ userId: string; status?: string }>,
  setCalls: [] as Array<{ userId: string; id: string; action: string }>,
  decisions: [] as Array<Record<string, unknown>>
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

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: () => {
    if (db.preferencesThrows) return Promise.reject(new Error('数据库连接中断'));
    return Promise.resolve({ decisionMemoryEnabled: db.enabled });
  }
}));

vi.mock('@/lib/cognitive/decisions', async (importOriginal) => {
  // 闸门（decisionModuleEnabled）走真代码：它读偏好的口径正是这里要钉的行为之一。
  const actual = await importOriginal<typeof import('@/lib/cognitive/decisions')>();
  return {
    ...actual,
    listDecisions: (userId: string, options?: { status?: string }) => {
      db.listCalls.push({ userId, status: options?.status });
      return Promise.resolve(db.decisions);
    },
    setDecisionStatus: (userId: string, id: string, action: string) => {
      db.setCalls.push({ userId, id, action });
      return Promise.resolve({ id, status: action === 'confirm' ? 'CONFIRMED' : 'REJECTED' });
    }
  };
});

vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));

async function get(url = 'http://x/api/account/decisions') {
  return GET(new Request(url));
}

async function patch(body: unknown) {
  return PATCH(
    new Request('http://x/api/account/decisions/d1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id: 'd1' }) }
  );
}

describe('决策接口', () => {
  beforeEach(() => {
    db.authThrows = false;
    db.enabled = false;
    db.preferencesThrows = false;
    db.listCalls = [];
    db.setCalls = [];
    db.decisions = [];
  });

  it('开关关着：GET 直接 409，且一次列表查询都不发', async () => {
    const res = await get();
    expect(res.status).toBe(409);
    expect(db.listCalls).toHaveLength(0);
  });

  it('开关关着：PATCH 同样不发服务层调用', async () => {
    const res = await patch({ action: 'confirm' });
    expect(res.status).toBe(409);
    expect(db.setCalls).toHaveLength(0);
  });

  it('偏好读不出来按关闭处理', async () => {
    db.preferencesThrows = true;
    const res = await get();
    expect(res.status).toBe(409);
    expect(db.listCalls).toHaveLength(0);
  });

  it('开着：GET 带身份取列表，status 参数透传', async () => {
    db.enabled = true;
    db.decisions = [{ id: 'd1', topic: '甲' }];
    const res = await get('http://x/api/account/decisions?status=PENDING_CONFIRM');
    expect(res.status).toBe(200);
    expect(db.listCalls).toEqual([{ userId: 'user-a', status: 'PENDING_CONFIRM' }]);
    const body = await res.json();
    expect(body.data.decisions).toEqual([{ id: 'd1', topic: '甲' }]);
  });

  it('status 参数不在白名单里是 400', async () => {
    db.enabled = true;
    const res = await get('http://x/api/account/decisions?status=NOPE');
    expect(res.status).toBe(400);
    expect(db.listCalls).toHaveLength(0);
  });

  it('开着：PATCH 把动词交给服务层', async () => {
    db.enabled = true;
    const res = await patch({ action: 'confirm' });
    expect(res.status).toBe(200);
    expect(db.setCalls).toEqual([{ userId: 'user-a', id: 'd1', action: 'confirm' }]);
  });

  it('动词不在白名单里是 400', async () => {
    db.enabled = true;
    const res = await patch({ action: 'maybe' });
    expect(res.status).toBe(400);
    expect(db.setCalls).toHaveLength(0);
  });

  it('未登录是 401', async () => {
    db.authThrows = true;
    const res = await get();
    expect(res.status).toBe(401);
  });
});
