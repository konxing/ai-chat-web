import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/account/decisions/[id]/route';
import { PATCH } from '@/app/api/account/decisions/[id]/outcomes/[outcomeId]/route';

/**
 * 决策详情与结果链接的路由层。钉四件事：
 * 开关关着读写都不发生（门槛 9）；详情带结果一起回；
 * 链接确认的动词白名单；归属缺失是 404 不是 500。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  enabled: false,
  getCalls: [] as Array<{ userId: string; id: string }>,
  linkCalls: [] as Array<{ userId: string; decisionId: string; outcomeId: string; action: string }>,
  found: null as null | { decision: Record<string, unknown>; outcomes: Array<Record<string, unknown>> }
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
  getCognitivePreferences: () => Promise.resolve({ decisionMemoryEnabled: db.enabled })
}));

vi.mock('@/lib/cognitive/decisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/decisions')>();
  return {
    ...actual,
    getDecisionWithOutcomes: (userId: string, id: string) => {
      db.getCalls.push({ userId, id });
      return Promise.resolve(db.found);
    },
    setOutcomeLink: (userId: string, decisionId: string, outcomeId: string, action: string) => {
      db.linkCalls.push({ userId, decisionId, outcomeId, action });
      return Promise.resolve({ id: outcomeId, linkStatus: action === 'link' ? 'LINKED' : 'DETACHED' });
    }
  };
});

vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));

function get() {
  return GET(new Request('http://x/api/account/decisions/d1'), {
    params: Promise.resolve({ id: 'd1' })
  });
}

function patch(body: unknown) {
  return PATCH(new Request('http://x/api/account/decisions/d1/outcomes/o1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), { params: Promise.resolve({ id: 'd1', outcomeId: 'o1' }) });
}

describe('决策详情与结果链接路由', () => {
  beforeEach(() => {
    db.authThrows = false;
    db.enabled = false;
    db.getCalls = [];
    db.linkCalls = [];
    db.found = null;
  });

  it('开关关着：详情和链接确认都不发服务层调用', async () => {
    expect((await get()).status).toBe(409);
    expect((await patch({ action: 'link' })).status).toBe(409);
    expect(db.getCalls).toHaveLength(0);
    expect(db.linkCalls).toHaveLength(0);
  });

  it('开着：详情带结果一起回', async () => {
    db.enabled = true;
    db.found = { decision: { id: 'd1' }, outcomes: [{ id: 'o1' }] };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ decision: { id: 'd1' }, outcomes: [{ id: 'o1' }] });
  });

  it('开着：不存在的决策是 404', async () => {
    db.enabled = true;
    expect((await get()).status).toBe(404);
  });

  it('开着：链接确认把动词交给服务层', async () => {
    db.enabled = true;
    const res = await patch({ action: 'detach' });
    expect(res.status).toBe(200);
    expect(db.linkCalls).toEqual([
      { userId: 'user-a', decisionId: 'd1', outcomeId: 'o1', action: 'detach' }
    ]);
  });

  it('动词不在白名单里是 400', async () => {
    db.enabled = true;
    expect((await patch({ action: 'shrug' })).status).toBe(400);
    expect(db.linkCalls).toHaveLength(0);
  });
});
