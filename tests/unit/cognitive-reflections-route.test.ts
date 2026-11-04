import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as list } from '@/app/api/account/cognitive/reflections/route';
import { GET as readOne, PATCH } from '@/app/api/account/cognitive/reflections/[id]/route';

/**
 * 洞察接口（任务书 6.4 那一屏的后端）。钉的是路由层的四件事：
 * 一、身份只来自 session；
 * 二、reflectionEnabled 关着时 GET 和 PATCH 都**一次服务层调用都不发**（和时间线、决策同口径）；
 * 三、动作的形状由白名单收：`snooze` 只认 3/7/30 天，别的动词或天数是 400 而不是 500；
 * 四、单条读不到一律 404——不许出现「存在但对你说没有」这种会泄露别人 id 的区分。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  enabled: false,
  preferencesThrows: false,
  rateLimited: false,
  listCalls: [] as Array<{ userId: string; state?: string; nowIsDate: boolean }>,
  readCalls: [] as Array<{ userId: string; id: string }>,
  setCalls: [] as Array<Record<string, unknown>>,
  reflections: [] as Array<Record<string, unknown>>,
  found: null as unknown
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
    return Promise.resolve({ reflectionEnabled: db.enabled });
  }
}));

vi.mock('@/lib/cognitive/reflections', async (importOriginal) => {
  // 闸门（reflectionModuleEnabled）走真代码：它读偏好的口径正是这里要钉的行为之一。
  const actual = await importOriginal<typeof import('@/lib/cognitive/reflections')>();
  return {
    ...actual,
    listReflections: (userId: string, options: { state?: string; now: Date }) => {
      db.listCalls.push({ userId, state: options.state, nowIsDate: options.now instanceof Date });
      return Promise.resolve(db.reflections);
    },
    getReflectionWithCitations: (userId: string, id: string) => {
      db.readCalls.push({ userId, id });
      return Promise.resolve(db.found);
    },
    setReflectionStatus: (userId: string, id: string, input: Record<string, unknown>) => {
      db.setCalls.push({ userId, id, ...input });
      return Promise.resolve({ id, status: 'ACCEPTED' });
    }
  };
});

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => (db.rateLimited ? { ok: false, retryAfterSec: 120 } : { ok: true })
}));

function getList(url = 'http://x/api/account/cognitive/reflections') {
  return list(new Request(url));
}

function getOne(id = 'r1') {
  return readOne(new Request(`http://x/api/account/cognitive/reflections/${id}`), {
    params: Promise.resolve({ id })
  });
}

function patch(body: unknown, id = 'r1') {
  return PATCH(
    new Request(`http://x/api/account/cognitive/reflections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe('洞察接口', () => {
  beforeEach(() => {
    db.authThrows = false;
    db.enabled = false;
    db.preferencesThrows = false;
    db.rateLimited = false;
    db.listCalls = [];
    db.readCalls = [];
    db.setCalls = [];
    db.reflections = [];
    db.found = null;
  });

  it('开关关着：列表 409，且一次查询都不发', async () => {
    const res = await getList();
    expect(res.status).toBe(409);
    expect(db.listCalls).toHaveLength(0);
  });

  it('开关关着：单条读和动作同样不发服务层调用', async () => {
    expect((await getOne()).status).toBe(409);
    expect((await patch({ action: 'accept' })).status).toBe(409);
    expect(db.readCalls).toHaveLength(0);
    expect(db.setCalls).toHaveLength(0);
  });

  it('偏好读不出来按关闭处理', async () => {
    db.preferencesThrows = true;
    const res = await getList();
    expect(res.status).toBe(409);
    expect(db.listCalls).toHaveLength(0);
  });

  it('开着：带身份取列表，state 透传，时间由服务端盖', async () => {
    db.enabled = true;
    db.reflections = [{ id: 'r1', status: 'PENDING' }];
    const res = await getList('http://x/api/account/cognitive/reflections?state=PENDING');
    expect(res.status).toBe(200);
    expect(db.listCalls).toEqual([{ userId: 'user-a', state: 'PENDING', nowIsDate: true }]);
    const body = await res.json();
    expect(body.data.reflections).toEqual([{ id: 'r1', status: 'PENDING' }]);
  });

  it('不传 state 就是全部状态：过滤是界面自己的事', async () => {
    db.enabled = true;
    await getList();
    expect(db.listCalls[0]!.state).toBeUndefined();
  });

  it('state 不在枚举里是 400，且不查库', async () => {
    db.enabled = true;
    const res = await getList('http://x/api/account/cognitive/reflections?state=NOPE');
    expect(res.status).toBe(400);
    expect(db.listCalls).toHaveLength(0);
  });

  it('单条读不到是 404，不存在和别人的行给同一个答案', async () => {
    db.enabled = true;
    const res = await getOne('nope');
    expect(res.status).toBe(404);
    expect(db.readCalls).toEqual([{ userId: 'user-a', id: 'nope' }]);
  });

  it('单条读到就把引用一起回', async () => {
    db.enabled = true;
    db.found = { reflection: { id: 'r1' }, citations: [{ id: 'c1', text: '我住在杭州' }] };
    const res = await getOne();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.citations).toEqual([{ id: 'c1', text: '我住在杭州' }]);
  });

  it('动作把整份形状交给服务层，now 由服务端盖', async () => {
    db.enabled = true;
    const res = await patch({ action: 'snooze', days: 7 });
    expect(res.status).toBe(200);
    expect(db.setCalls).toHaveLength(1);
    expect(db.setCalls[0]).toMatchObject({ userId: 'user-a', id: 'r1', action: 'snooze', days: 7 });
    expect(db.setCalls[0]!.now).toBeInstanceOf(Date);
  });

  it('改正文把两段文字一起传下去', async () => {
    db.enabled = true;
    const res = await patch({ action: 'edit', title: '我确实总在换项目', body: '因为没想清楚要什么。' });
    expect(res.status).toBe(200);
    expect(db.setCalls[0]).toMatchObject({ action: 'edit', title: '我确实总在换项目' });
  });

  it('动词不在白名单里是 400', async () => {
    db.enabled = true;
    expect((await patch({ action: 'maybe' })).status).toBe(400);
    expect(db.setCalls).toHaveLength(0);
  });

  it('稍后的天数只认 3/7/30：别的数字是 400，不是让服务层自己去猜', async () => {
    db.enabled = true;
    expect((await patch({ action: 'snooze', days: 5 })).status).toBe(400);
    expect((await patch({ action: 'snooze' })).status).toBe(400);
    expect(db.setCalls).toHaveLength(0);
  });

  it('改正文缺任一段是 400', async () => {
    db.enabled = true;
    expect((await patch({ action: 'edit', title: '只有标题' })).status).toBe(400);
    expect(db.setCalls).toHaveLength(0);
  });

  it('限流命中是 429，且不动库', async () => {
    db.enabled = true;
    db.rateLimited = true;
    const res = await patch({ action: 'accept' });
    expect(res.status).toBe(429);
    expect(db.setCalls).toHaveLength(0);
  });

  it('未登录是 401', async () => {
    db.authThrows = true;
    expect((await getList()).status).toBe(401);
  });
});
