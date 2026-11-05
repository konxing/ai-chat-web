import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 画像接口（任务书 8.2 / 8.3 那一屏的后端）。
 *
 * 钉的是路由层这一层的六个决定，派生逻辑本身在 cognitive-profile-reads.test.ts 里逐条钉过：
 *
 * 一、身份只来自 session——查询串和请求体里的 userId 都换不掉归属；
 * 二、`userModelEnabled` 关着时四个动词都**一次服务层调用都不发**。这一屏读的是密文、写的也是密文，
 *     闸门晚一步就等于给关了画像的用户解密整屏或者落一行（任务书 1.1「关闭模块后不能继续执行对应的数据读取」）。
 *     这里闸门走真代码（`profileGates` 不被 mock），所以「偏好读不出来按关闭处理」也是当场验的；
 * 三、**确认时间递不进来**。请求体里写 `confirmedAt` 会被白名单丢掉，服务层收到的形状里没有这个键——
 *     「库里只存你确认过的」这件事在服务层是靠参数里没有这个字段做的（user-profile.ts 文件头），
 *     路由不能又把它从后门递回去；
 * 四、限流命中是 429 且不动库；清空全部和单条删各算各的桶；
 * 五、审计只带 id 和计数，正文一次都不进审计（任务书 5.5）；
 * 六、四条路由都不 import 洞察那一屏的读侧模块——那条静态禁令扫遍 src，这里踩上去会连带红别的用例。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  userModelEnabled: false,
  memoryEnabled: true,
  reflectionEnabled: true,
  preferencesThrows: false,
  rateLimited: false,
  screenCalls: [] as Array<{ userId: string; nowIsDate: boolean; gates: Record<string, boolean> }>,
  createCalls: [] as Array<Record<string, unknown>>,
  reviseCalls: [] as Array<Record<string, unknown>>,
  deleteCalls: [] as Array<{ userId: string; id: string }>,
  clearCalls: [] as string[],
  screen: { entries: [], entriesCapped: false, candidates: [] } as Record<string, unknown>,
  created: { id: 'pro-1', content: '我习惯先把事写完再聊' } as Record<string, unknown>,
  deleted: true,
  cleared: 7,
  audits: [] as Array<Record<string, unknown>>
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
    return Promise.resolve({
      userModelEnabled: db.userModelEnabled,
      memoryEnabled: db.memoryEnabled,
      reflectionEnabled: db.reflectionEnabled
    });
  }
}));

// 闸门走真代码：它读偏好的口径（包括读不出来按全关）正是这里要钉的行为之一。
vi.mock('@/lib/cognitive/profile-reads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/profile-reads')>();
  return {
    ...actual,
    readProfileScreen: (userId: string, now: Date, gates: { userModelEnabled: boolean; memoryEnabled: boolean; reflectionEnabled: boolean }) => {
      db.screenCalls.push({ userId, nowIsDate: now instanceof Date, gates: { ...gates } });
      return Promise.resolve(db.screen);
    }
  };
});

vi.mock('@/lib/cognitive/user-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/user-profile')>();
  return {
    ...actual,
    createProfileEntry: (input: Record<string, unknown>) => {
      db.createCalls.push(input);
      return Promise.resolve(db.created);
    },
    reviseProfileEntry: (input: Record<string, unknown>) => {
      db.reviseCalls.push(input);
      return Promise.resolve({ id: String(input.id), content: String(input.content) });
    },
    deleteProfileEntry: (userId: string, id: string) => {
      db.deleteCalls.push({ userId, id });
      return Promise.resolve(db.deleted);
    },
    clearProfileEntries: (userId: string) => {
      db.clearCalls.push(userId);
      return Promise.resolve(db.cleared);
    }
  };
});

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => (db.rateLimited ? { ok: false, retryAfterSec: 120 } : { ok: true })
}));

vi.mock('@/lib/audit', () => ({
  writeAudit: (entry: Record<string, unknown>) => {
    db.audits.push(entry);
    return Promise.resolve();
  }
}));

const COLLECTION = 'http://127.0.0.1:3000/api/account/cognitive/profile';

function source(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

async function collection(method: 'GET' | 'POST' | 'DELETE', body?: unknown, query = '') {
  const route = await import('@/app/api/account/cognitive/profile/route');
  const init: RequestInit = { method, headers: { origin: 'http://127.0.0.1:3000' } };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return route[method === 'GET' ? 'GET' : method === 'POST' ? 'POST' : 'DELETE'](
    new Request(`${COLLECTION}${query}`, init)
  );
}

async function single(method: 'PATCH' | 'DELETE', body: unknown, id = 'pro-1') {
  const route = await import('@/app/api/account/cognitive/profile/[id]/route');
  return route[method](new Request(`${COLLECTION}/${id}`, {
    method,
    headers: { origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  db.authThrows = false;
  db.userModelEnabled = true;
  db.memoryEnabled = true;
  db.reflectionEnabled = true;
  db.preferencesThrows = false;
  db.rateLimited = false;
  db.screenCalls = [];
  db.createCalls = [];
  db.reviseCalls = [];
  db.deleteCalls = [];
  db.clearCalls = [];
  db.screen = { entries: [], entriesCapped: false, candidates: [] };
  db.created = { id: 'pro-1', content: '我习惯先把事写完再聊' };
  db.deleted = true;
  db.cleared = 7;
  db.audits = [];
});

describe('闸门：关着是真的不读不写', () => {
  it('未登录 401，一次服务层调用都不发', async () => {
    db.authThrows = true;

    expect((await collection('GET')).status).toBe(401);
    expect((await collection('POST', { content: '甲' })).status).toBe(401);
    expect((await collection('DELETE')).status).toBe(401);
    expect((await single('PATCH', { content: '甲' })).status).toBe(401);
    expect(db.screenCalls).toEqual([]);
    expect(db.createCalls).toEqual([]);
  });

  it('userModelEnabled 关着：四个动词全 409，一次服务层调用都不发', async () => {
    db.userModelEnabled = false;
    db.screen = { entries: [{ id: 'pro-1', content: '别人的画像' }], entriesCapped: false, candidates: [] };

    const responses = await Promise.all([
      collection('GET'),
      collection('POST', { content: '甲' }),
      collection('DELETE'),
      single('PATCH', { content: '甲' }),
      single('DELETE', {})
    ]);

    for (const response of responses) {
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('MODULE_DISABLED');
    }
    expect(db.screenCalls).toEqual([]);
    expect(db.createCalls).toEqual([]);
    expect(db.reviseCalls).toEqual([]);
    expect(db.deleteCalls).toEqual([]);
    expect(db.clearCalls).toEqual([]);
  });

  it('读侧和写侧的文案各自说清：一个是「不读取」，一个是「不能写」', async () => {
    db.userModelEnabled = false;

    const read = await collection('GET');
    const write = await collection('POST', { content: '甲' });

    expect((await read.json()).error.message).toBe('用户画像没有打开；打开后这里才会读取并展示你的画像');
    expect((await write.json()).error.message).toBe('用户画像没有打开；打开后才能写入或修改画像');
  });

  it('偏好读不出来按关闭处理：拿不准的时候宁可一行都不写', async () => {
    db.preferencesThrows = true;

    expect((await collection('GET')).status).toBe(409);
    expect((await collection('DELETE')).status).toBe(409);
    expect(db.screenCalls).toEqual([]);
    expect(db.clearCalls).toEqual([]);
  });

  it('三道闸门一次请求只读一遍偏好', async () => {
    await collection('GET');

    expect(db.screenCalls).toHaveLength(1);
    expect(db.screenCalls[0].gates).toEqual({ userModelEnabled: true, memoryEnabled: true, reflectionEnabled: true });
  });
});

describe('GET：一屏的原样', () => {
  it('时间由服务端盖、身份只来自 session，查询串里的 userId 换不掉归属', async () => {
    db.screen = { entries: [{ id: 'pro-1' }], entriesCapped: true, candidates: [{ from: 'memory', content: '甲' }] };

    const response = await collection('GET', undefined, '?userId=user-b');
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(db.screenCalls[0].userId).toBe('user-a');
    expect(db.screenCalls[0].nowIsDate).toBe(true);
    expect(payload.data).toEqual({ entries: [{ id: 'pro-1' }], entriesCapped: true, candidates: [{ from: 'memory', content: '甲' }] });
  });
});

describe('POST：确认候选或亲笔写一条', () => {
  it('正文和两份来源 id 都递给服务层，前后空格在入口就去掉', async () => {
    const response = await collection('POST', {
      content: '  我习惯先把事写完再聊  ',
      sourceMemoryIds: ['mem-1', 'mem-2'],
      sourceReflectionIds: ['ref-1']
    });

    expect(response.status).toBe(200);
    expect(db.createCalls[0]).toMatchObject({
      userId: 'user-a',
      content: '我习惯先把事写完再聊',
      sourceMemoryIds: ['mem-1', 'mem-2'],
      sourceReflectionIds: ['ref-1']
    });
    expect((await response.json()).data.entry).toEqual(db.created);
  });

  it('确认时间递不进来：请求体里写 confirmedAt，服务层收到的形状里没有这个键', async () => {
    await collection('POST', { content: '甲', confirmedAt: '2020-01-01T00:00:00.000Z' });

    expect(Object.keys(db.createCalls[0] ?? {})).not.toContain('confirmedAt');
    expect(db.createCalls[0]).not.toHaveProperty('confirmedAt');
  });

  it('空正文、只有空格的正文、超 1000 字的正文都是 400，且一次写都不发', async () => {
    expect((await collection('POST', { content: '' })).status).toBe(400);
    expect((await collection('POST', { content: '   ' })).status).toBe(400);
    expect((await collection('POST', { content: '字'.repeat(1001) })).status).toBe(400);
    expect((await collection('POST', {})).status).toBe(400);
    expect(db.createCalls).toEqual([]);
  });

  it('1000 字整条收：上限是「不能超过」，不是「提前一位就挡」', async () => {
    expect((await collection('POST', { content: '字'.repeat(1000) })).status).toBe(200);
  });

  it('来源数组只认 id 字符串，超长或非字符串是 400', async () => {
    expect((await collection('POST', { content: '甲', sourceMemoryIds: Array.from({ length: 21 }, (_, i) => `mem-${i}`) })).status).toBe(400);
    expect((await collection('POST', { content: '甲', sourceReflectionIds: 'ref-1' })).status).toBe(400);
    expect((await collection('POST', { content: '甲', sourceMemoryIds: [{ id: 'mem-1' }] })).status).toBe(400);
    expect(db.createCalls).toEqual([]);
  });

  it('限流命中是 429，且一行都不写', async () => {
    db.rateLimited = true;

    const response = await collection('POST', { content: '甲' });

    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toBe('操作过于频繁，请在 120 秒后重试');
    expect(db.createCalls).toEqual([]);
  });

  it('审计只带条目 id 和来源条数，没有正文', async () => {
    await collection('POST', { content: '我习惯先把事写完再聊', sourceMemoryIds: ['mem-1'] });

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorId: 'user-a',
      action: 'user.profile_create',
      targetType: 'profile',
      targetId: 'pro-1',
      after: { memories: 1, reflections: 0 }
    });
    expect(JSON.stringify(db.audits[0])).not.toContain('我习惯先把事写完再聊');
  });
});

describe('PATCH / DELETE 单条', () => {
  it('改正文只递正文：来源数组从这扇门递不进去', async () => {
    const response = await single('PATCH', { content: '改成这句才对', sourceMemoryIds: ['mem-9'] });

    // 白名单不收的键会被丢掉（和 memoryReviseSchema 那扇门同一口径），这里钉的是服务层收到的形状里没有它：
    // 「你确认那一刻的依据」不跟着正文一起被改写，靠的是这一份入参里没有那两根数组。
    expect(response.status).toBe(200);
    expect(db.reviseCalls).toEqual([{ userId: 'user-a', id: 'pro-1', content: '改成这句才对' }]);
  });

  it('改正文把 id 和 session 用户一起递给服务层，空正文是 400', async () => {
    expect((await single('PATCH', { content: '改成这句才对' })).status).toBe(200);
    expect(db.reviseCalls).toEqual([{ userId: 'user-a', id: 'pro-1', content: '改成这句才对' }]);

    expect((await single('PATCH', { content: '  ' })).status).toBe(400);
  });

  it('删一条：删掉了回 deleted，删空了回 404（别人的 id 和不存在给同一个答案）', async () => {
    expect((await single('DELETE', {})).status).toBe(200);

    db.deleted = false;
    const missing = await single('DELETE', {});
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('PROFILE_NOT_FOUND');
    expect(db.deleteCalls).toEqual([{ userId: 'user-a', id: 'pro-1' }, { userId: 'user-a', id: 'pro-1' }]);
  });

  it('单条删和清空各算各的桶：限流命中都是 429 且都不动库', async () => {
    db.rateLimited = true;

    expect((await single('DELETE', {})).status).toBe(429);
    expect((await collection('DELETE')).status).toBe(429);
    expect((await single('PATCH', { content: '甲' })).status).toBe(429);
    expect(db.deleteCalls).toEqual([]);
    expect(db.clearCalls).toEqual([]);
    expect(db.reviseCalls).toEqual([]);
  });

  it('删一条留痕，审计里只有 id', async () => {
    await single('DELETE', {});

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: 'user.profile_delete', targetType: 'profile', targetId: 'pro-1' });
    expect(JSON.stringify(db.audits[0])).not.toContain('我习惯先把事写完再聊');
  });
});

describe('DELETE 集合：面板那个明确的清空入口', () => {
  it('清空只删这个用户的条目，回条数并留痕', async () => {
    const response = await collection('DELETE');

    expect(response.status).toBe(200);
    expect(db.clearCalls).toEqual(['user-a']);
    expect((await response.json()).data).toEqual({ cleared: 7 });
    expect(db.audits[0]).toMatchObject({ action: 'user.profile_clear', targetType: 'user', targetId: 'user-a', after: { cleared: 7 } });
  });

  it('一条都没清掉也照样回 200 和 0：清空入口不是「有没有东西」的探针', async () => {
    db.cleared = 0;

    const response = await collection('DELETE');

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ cleared: 0 });
  });
});

describe('静态：这一片不踩别的屏钉下的禁令', () => {
  it('四条路由都不 import 洞察那一屏的读侧模块', () => {
    for (const file of [
      'src/app/api/account/cognitive/profile/route.ts',
      'src/app/api/account/cognitive/profile/[id]/route.ts'
    ]) {
      expect(source(file), `${file} 不该读洞察那一屏`).not.toContain('cognitive/reflections');
    }
  });
});
