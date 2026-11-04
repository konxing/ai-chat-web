import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 记忆管理接口（任务书 8.2「记忆管理」那一屏的后端）。这一片钉的是四件事——
 * 用户能看见 AI 记了自己什么；改口和撤回都留得下原因；
 * 别人的记忆既读不到也改不动；审计里一个字的正文都没有。
 *
 * @/lib/cognitive/memories 在这里是 mock 的：加密、双时间过滤、演化事务
 * 已经在 cognitive-memories.test.ts 里测过 28 条，这里要测的是路由自己那层决策——
 * 身份从哪来、origin 谁说了算、404 怎么映射、限流挡在哪一步。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  limiterOk: true,
  limiterCalls: [] as Array<{ key: string; limit: number; windowMs: number }>,
  listCalls: [] as unknown[],
  getCalls: [] as Array<{ id: string; userId: string }>,
  revisionCalls: [] as Array<{ id: string; userId: string }>,
  reviseCalls: [] as Array<Record<string, unknown>>,
  retractCalls: [] as Array<{ id: string; userId: string; reason: string }>,
  archiveCalls: [] as Array<{ id: string; userId: string }>,
  restoreCalls: [] as Array<{ id: string; userId: string }>,
  purgeCalls: [] as Array<{ id: string; userId: string }>,
  purgeChatCalls: [] as Array<{ chatId: string; userId: string }>,
  purgeAllCalls: [] as string[],
  learnCalls: [] as Array<{ userId: string; contexts: string[] }>,
  learned: [] as string[],
  assessCalls: [] as Array<{ userId: string; ids: string[] }>,
  confidence: new Map<string, Record<string, unknown>>(),
  evidenceCalls: [] as Array<{ memoryId: string; userId: string }>,
  evidenceRows: [] as Array<Record<string, unknown>>,
  titleCalls: [] as Array<{ userId: string; chatIds: Array<string | null> }>,
  audits: [] as Array<Record<string, unknown>>,
  stored: new Map<string, Record<string, unknown>>()
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

vi.mock('@/lib/cognitive/memories', () => ({
  listMemories: (userId: string, filters?: { archivedOnly?: boolean }) => {
    db.listCalls.push({ userId, filters });
    // 真实现只给「还没被取代、也没被撤回、也没归档」的行；按同一语义筛，
    // 否则「撤回后不再出现」「归档后不再出现」这两条用例测的都是个空壳。
    // archivedOnly 是「记忆」那一屏的恢复列表：同三个条件，只把归档反过来。
    const archivedOnly = filters?.archivedOnly === true;
    return Promise.resolve(
      [...db.stored.values()].filter(
        (row) =>
          row.userId === userId &&
          row.supersededAt === null &&
          row.origin !== 'retracted' &&
          (archivedOnly ? row.archivedAt !== undefined && row.archivedAt !== null : !row.archivedAt)
      )
    );
  },
  getMemory: (id: string, userId: string) => {
    db.getCalls.push({ id, userId });
    return Promise.resolve(db.stored.get(`${userId}|${id}`) ?? null);
  },
  listMemoryRevisions: (id: string, userId: string) => {
    db.revisionCalls.push({ id, userId });
    return Promise.resolve([
      {
        id: 'edge-1',
        action: 'superseded',
        memoryId: id,
        previousId: 'mem-old',
        reason: '用户在后续对话中再次提到这件事，按新版本处理',
        sourceMessageId: 'msg-9',
        createdAt: '2026-11-02T10:00:00.000Z'
      }
    ]);
  },
  reviseMemory: (input: Record<string, unknown>) => {
    db.reviseCalls.push(input);
    return Promise.resolve({
      ...input,
      id: 'mem-new',
      version: 2,
      supersededAt: null,
      recordedAt: '2026-11-02T12:00:00.000Z'
    });
  },
  retractMemory: (id: string, userId: string, reason: string) => {
    db.retractCalls.push({ id, userId, reason });
    const row = db.stored.get(`${userId}|${id}`);
    if (!row) return Promise.resolve(false);
    row.origin = 'retracted';
    return Promise.resolve(true);
  },
  archiveMemory: (id: string, userId: string) => {
    db.archiveCalls.push({ id, userId });
    const row = db.stored.get(`${userId}|${id}`);
    if (!row) return Promise.resolve(false);
    row.archivedAt = '2026-11-05T10:00:00.000Z';
    return Promise.resolve(true);
  },
  restoreMemory: (id: string, userId: string) => {
    db.restoreCalls.push({ id, userId });
    const row = db.stored.get(`${userId}|${id}`);
    if (!row) return Promise.resolve(false);
    delete row.archivedAt;
    return Promise.resolve(true);
  }
}));

vi.mock('@/lib/cognitive/forgetting', () => ({
  purgeMemory: (id: string, userId: string) => {
    db.purgeCalls.push({ id, userId });
    const key = `${userId}|${id}`;
    const row = db.stored.get(key);
    if (!row) return Promise.resolve({ purged: 0, contexts: [] });
    db.stored.delete(key);
    return Promise.resolve({ purged: 1, contexts: [row.context ?? 'general'] });
  },
  purgeMemoriesByChat: (chatId: string, userId: string) => {
    db.purgeChatCalls.push({ chatId, userId });
    let count = 0;
    const contexts = new Set<string>();
    for (const [key, row] of [...db.stored]) {
      if (row.userId === userId && row.chatId === chatId) {
        db.stored.delete(key);
        count += 1;
        contexts.add(String(row.context ?? 'general'));
      }
    }
    return Promise.resolve({ purged: count, contexts: [...contexts] });
  },
  purgeAllMemories: (userId: string) => {
    db.purgeAllCalls.push(userId);
    let count = 0;
    for (const [key, row] of [...db.stored]) {
      if (row.userId === userId) {
        db.stored.delete(key);
        count += 1;
      }
    }
    // 清空全部不产生学习证据：一次重置不该被读成「七个情境都记太多了」。
    return Promise.resolve({ purged: count, contexts: [] });
  }
}));

vi.mock('@/lib/cognitive/policy-learner', () => ({
  learnAfterPurge: (userId: string, contexts: string[]) => {
    db.learnCalls.push({ userId, contexts });
    return Promise.resolve(db.learned);
  }
}));

vi.mock('@/lib/cognitive/evidence', () => ({
  assessMemories: (userId: string, memories: Array<{ id: string }>) => {
    db.assessCalls.push({ userId, ids: memories.map((memory) => memory.id) });
    return Promise.resolve(new Map([...db.confidence]));
  },
  listEvidence: (memoryId: string, userId: string) => {
    db.evidenceCalls.push({ memoryId, userId });
    return Promise.resolve(db.evidenceRows);
  }
}));

vi.mock('@/lib/chats', () => ({
  listChatTitles: (userId: string, chatIds: Array<string | null>) => {
    db.titleCalls.push({ userId, chatIds });
    // 真实现只返回查得到的会话；这里给每个 id 一个标题，测的是路由传什么进去、带什么回去。
    return Promise.resolve(
      Object.fromEntries(chatIds.filter((id): id is string => Boolean(id)).map((id) => [id, `标题 ${id}`]))
    );
  }
}));

const BASE = 'http://127.0.0.1:3000/api/account/cognitive/memories';

/** 服务层返回的那一行的形状；到这里正文已经是解密后的明文，只回给所有者。 */
function memoryDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    userId: 'user-a',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'project',
    context: 'technicalProject',
    origin: 'explicit',
    content: '我在用 Prisma',
    confirmedAt: '2026-11-02T10:00:00.000Z',
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: '2026-11-02T10:00:00.000Z',
    ...overrides
  };
}

function store(row: Record<string, unknown>) {
  db.stored.set(`${row.userId}|${row.id}`, row);
}

/** path 是 URL 上 BASE 后面的那截：'' 列表、'/mem-1' 单条、'/mem-1/retract' 撤回、'/mem-1/archive' 归档。 */
async function call(method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path = '', body?: unknown, query = '') {
  const request = new Request(`${BASE}${path}${query}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const route = path.endsWith('/retract')
    ? await import('@/app/api/account/cognitive/memories/[id]/retract/route')
    : path.endsWith('/archive')
      ? await import('@/app/api/account/cognitive/memories/[id]/archive/route')
      : path.endsWith('/restore')
        ? await import('@/app/api/account/cognitive/memories/[id]/restore/route')
        : path.endsWith('/evidence')
      ? await import('@/app/api/account/cognitive/memories/[id]/evidence/route')
      : path === ''
        ? await import('@/app/api/account/cognitive/memories/route')
        : await import('@/app/api/account/cognitive/memories/[id]/route');
  // Next 15 把动态段做成 Promise 传进来；列表路由只收 request。
  const ctx = path === '' ? {} : { params: Promise.resolve({ id: path.split('/')[1] ?? '' }) };
  // 三个模块导出的动词各不相同（GET/PATCH/POST），按联合类型取不到，这里只按方法名查表。
  const handlers = route as unknown as Record<string, (req: Request, ctx?: unknown) => Promise<Response>>;
  const response = await handlers[method](request, ctx);
  return { response, payload: await response.json() };
}

beforeEach(() => {
  db.authThrows = false;
  db.limiterOk = true;
  db.limiterCalls = [];
  db.listCalls = [];
  db.getCalls = [];
  db.revisionCalls = [];
  db.reviseCalls = [];
  db.retractCalls = [];
  db.archiveCalls = [];
  db.restoreCalls = [];
  db.purgeCalls = [];
  db.purgeChatCalls = [];
  db.purgeAllCalls = [];
  db.learnCalls = [];
  db.learned = [];
  db.assessCalls = [];
  db.confidence = new Map();
  db.evidenceCalls = [];
  db.evidenceRows = [];
  db.titleCalls = [];
  db.audits = [];
  db.stored.clear();
});

describe('读：用户看 AI 记了自己什么', () => {
  it('未登录时四个口子全是 401，一次服务调用都不发', async () => {
    db.authThrows = true;

    const list = await call('GET');
    const one = await call('GET', '/mem-1');
    const patch = await call('PATCH', '/mem-1', { content: '我在用 Prisma', reason: '说错了' });
    const retract = await call('POST', '/mem-1/retract', { reason: '别记这个' });

    expect([list.response.status, one.response.status, patch.response.status, retract.response.status]).toEqual([
      401, 401, 401, 401
    ]);
    expect(db.listCalls).toEqual([]);
    expect(db.titleCalls).toEqual([]);
    expect(db.getCalls).toEqual([]);
    expect(db.reviseCalls).toEqual([]);
    expect(db.retractCalls).toEqual([]);
  });

  it('列表只按 session 用户查，查询串里的 userId 换不掉它', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));
    store(memoryDto({ id: 'mem-2', userId: 'user-b', content: '别人家的记忆' }));

    const { payload } = await call('GET', '', undefined, '?userId=user-b');

    expect(db.listCalls[0]).toMatchObject({ userId: 'user-a' });
    expect(payload.data.memories.map((memory: { content: string }) => memory.content)).toEqual(['我在用 Prisma']);
  });

  it('列表同时带回这些记忆来自哪次对话的标题，归属仍按 session 用户查', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));
    store(memoryDto({ id: 'mem-2', chatId: 'chat-2', content: '周末去爬山' }));

    const { payload } = await call('GET');

    expect(db.titleCalls).toEqual([{ userId: 'user-a', chatIds: ['chat-1', 'chat-2'] }]);
    expect(payload.data.chats).toEqual({ 'chat-1': '标题 chat-1', 'chat-2': '标题 chat-2' });
  });

  it('标题查询只喂当前列表里的 chatId，界面传什么都不多查一条', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));
    store(memoryDto({ id: 'mem-2', userId: 'user-b', chatId: 'chat-b', content: '别人家的记忆' }));

    await call('GET', '', undefined, '?chatId=chat-b');

    expect(db.titleCalls[0].chatIds).toEqual(['chat-1']);
  });

  it('记忆没有来源对话时带回空映射，不拿 null 去查库', async () => {
    store(memoryDto({ chatId: null, content: '我在用 Prisma' }));

    const { payload } = await call('GET');

    expect(db.titleCalls[0].chatIds).toEqual([null]);
    expect(payload.data.chats).toEqual({});
  });

  it('撤回过的记忆不再出现在当前列表里', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));

    await call('POST', '/mem-1/retract', { reason: '这个说错了，别记' });
    const { payload } = await call('GET');

    expect(payload.data.memories).toEqual([]);
  });

  it('单条返回这一条和它的演化边；别人的 id 一律 404，边也不给', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));

    const mine = await call('GET', '/mem-1');
    const theirs = await call('GET', '/mem-x');

    expect(mine.payload.data.memory.id).toBe('mem-1');
    expect(mine.payload.data.revisions[0].previousId).toBe('mem-old');
    expect(theirs.response.status).toBe(404);
    expect(theirs.payload.error.code).toBe('MEMORY_NOT_FOUND');
    expect(db.revisionCalls).toHaveLength(1);
  });
});

describe('改口：用户亲手更正', () => {
  it('origin 由服务端定成「用户已确认」，请求体里传什么都进不来', async () => {
    store(memoryDto({ content: '我在用 Next.js 14' }));

    await call('PATCH', '/mem-1', {
      content: '我在用 Next.js 15',
      reason: '版本记错了',
      origin: 'inferred',
      userId: 'user-b',
      type: 'goal'
    });

    expect(db.reviseCalls).toHaveLength(1);
    expect(db.reviseCalls[0]).toMatchObject({
      previousId: 'mem-1',
      userId: 'user-a',
      content: '我在用 Next.js 15',
      reason: '版本记错了',
      origin: 'userConfirmed'
    });
    // 用户此刻亲手改的，确认时间就是这一刻；拿旧行的时间回来冒充「当初确认过」是假证据。
    expect(db.reviseCalls[0].confirmedAt).toBeInstanceOf(Date);
  });

  it('正文一字没改时不产生演化，免得留一条没有信息量的版本', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));

    const { payload } = await call('PATCH', '/mem-1', { content: '  我在用 Prisma  ', reason: '其实没改' });

    expect(db.reviseCalls).toEqual([]);
    expect(payload.data.memory.id).toBe('mem-1');
  });

  it('空正文、超长正文、缺理由都是 400，服务函数一次都不调', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));

    const empty = await call('PATCH', '/mem-1', { content: '   ', reason: '改一下' });
    const tooLong = await call('PATCH', '/mem-1', { content: '字'.repeat(1001), reason: '改一下' });
    const noReason = await call('PATCH', '/mem-1', { content: '我在用 Prisma' });

    expect(empty.response.status).toBe(400);
    expect(tooLong.response.status).toBe(400);
    expect(noReason.response.status).toBe(400);
    expect(noReason.payload.error.code).toBe('VALIDATION_ERROR');
    expect(db.reviseCalls).toEqual([]);
  });

  it('目标不存在时 404，不改库也不写审计', async () => {
    const { response } = await call('PATCH', '/mem-x', { content: '我在用 Prisma', reason: '改一下' });

    expect(response.status).toBe(404);
    expect(db.reviseCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('审计里只有 id、版本和标签，正文和理由一个字都不落', async () => {
    store(memoryDto({ content: '我在用 Next.js 14' }));

    await call('PATCH', '/mem-1', { content: '我在用 Next.js 15', reason: '版本记错了' });

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorId: 'user-a',
      action: 'user.memory_revise',
      targetType: 'memory',
      targetId: 'mem-1'
    });
    const serialized = JSON.stringify(db.audits[0]);
    expect(serialized).not.toContain('Next.js');
    expect(serialized).not.toContain('版本记错了');
  });
});

describe('撤回', () => {
  it('撤回只针对 session 用户那一行，理由必填', async () => {
    store(memoryDto({ type: 'fact', context: 'general', content: '我叫小明' }));

    const { payload } = await call('POST', '/mem-1/retract', { reason: '名字说错了' });

    expect(db.retractCalls).toEqual([{ id: 'mem-1', userId: 'user-a', reason: '名字说错了' }]);
    expect(payload.data.retracted).toBe(true);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: 'user.memory_retract', targetId: 'mem-1' });
    expect(JSON.stringify(db.audits[0])).not.toContain('小明');
    expect(JSON.stringify(db.audits[0])).not.toContain('名字说错了');
  });

  it('缺理由 400，别人的行 404，两种情况都不写审计', async () => {
    store(memoryDto({ content: '我叫小明' }));

    const noReason = await call('POST', '/mem-1/retract', {});
    const theirs = await call('POST', '/mem-x/retract', { reason: '删掉' });

    expect(noReason.response.status).toBe(400);
    expect(theirs.response.status).toBe(404);
    // 缺理由那次连服务函数都不该碰，所以这里只有别人的 id 那一次调用——按 userId 复合作用域查，
    // 查不到就是 404，不给「存在但不属于你」这种可以被枚举出答案的差别。
    expect(db.retractCalls).toEqual([{ id: 'mem-x', userId: 'user-a', reason: '删掉' }]);
    expect(db.audits).toEqual([]);
  });
});

/**
 * 任务书 7.2 的 ARCHIVE：「归档，仍可在允许范围内恢复」。
 * 路由这一层钉四件事：谁能动（只有 session 用户）、动了什么（只一列）、审计里不许有正文，
 * 以及「可逆」必须有个界面读得到的出口——GET 要把已归档那几行一起带回来，
 * 否则归档就是一扇进得去出不来的门。
 */
describe('归档与恢复（任务书 7.2 的 ARCHIVE）', () => {
  it('归档只按 session 用户那一行，请求体一个字都不需要', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));

    const { payload } = await call('POST', '/mem-1/archive');

    expect(db.archiveCalls).toEqual([{ id: 'mem-1', userId: 'user-a' }]);
    expect(payload.data.archived).toBe(true);
  });

  it('归档过的行从当前列表里出去，出现在 archived 那一份里，正文照样是解过密的', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));
    await call('POST', '/mem-1/archive');

    const { payload } = await call('GET');

    expect(payload.data.memories).toEqual([]);
    expect(payload.data.archived.map((row: { id: string }) => row.id)).toEqual(['mem-1']);
    expect(payload.data.archived[0].content).toBe('我在用 Prisma');
  });

  it('恢复把它放回当前有效那一份，已归档那一份跟着空掉', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));
    await call('POST', '/mem-1/archive');

    const { payload } = await call('POST', '/mem-1/restore');
    const list = await call('GET');

    expect(db.restoreCalls).toEqual([{ id: 'mem-1', userId: 'user-a' }]);
    expect(payload.data.restored).toBe(true);
    expect(list.payload.data.memories.map((row: { id: string }) => row.id)).toEqual(['mem-1']);
    expect(list.payload.data.archived).toEqual([]);
  });

  it('别人的 id：两条路都 404，条件里带的仍然是调用者自己的 userId，审计一个字都不写', async () => {
    store(memoryDto({ userId: 'user-b', id: 'mem-b' }));

    const archive = await call('POST', '/mem-b/archive');
    const restore = await call('POST', '/mem-b/restore');

    expect([archive.response.status, restore.response.status]).toEqual([404, 404]);
    expect(db.archiveCalls).toEqual([{ id: 'mem-b', userId: 'user-a' }]);
    expect(db.restoreCalls).toEqual([{ id: 'mem-b', userId: 'user-a' }]);
    expect(db.audits).toEqual([]);
  });

  it('审计里只有动作、id 和 ip，正文一个字节都不落', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));
    await call('POST', '/mem-1/archive');
    await call('POST', '/mem-1/restore');

    expect(db.audits.map((audit) => audit.action)).toEqual(['user.memory_archive', 'user.memory_restore']);
    expect(db.audits[0]).toMatchObject({ targetId: 'mem-1', targetType: 'memory' });
    expect(JSON.stringify(db.audits)).not.toContain('Prisma');
  });

  it('未登录时两条路都是 401，一次服务调用都不发', async () => {
    db.authThrows = true;

    const archive = await call('POST', '/mem-1/archive');
    const restore = await call('POST', '/mem-1/restore');

    expect([archive.response.status, restore.response.status]).toEqual([401, 401]);
    expect(db.archiveCalls).toEqual([]);
    expect(db.restoreCalls).toEqual([]);
  });

  it('触发限流时两条路各回 429，服务函数和审计都不发', async () => {
    store(memoryDto());
    db.limiterOk = false;

    const archive = await call('POST', '/mem-1/archive');
    const restore = await call('POST', '/mem-1/restore');

    expect([archive.response.status, restore.response.status]).toEqual([429, 429]);
    expect(db.archiveCalls).toEqual([]);
    expect(db.restoreCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('归档和恢复分桶：整理一屏记忆不该把「反悔」的那一路一起挡住', async () => {
    store(memoryDto());
    await call('POST', '/mem-1/archive');
    await call('POST', '/mem-1/restore');

    expect(db.limiterCalls.map((entry) => entry.key)).toEqual(['memory-archive:user-a', 'memory-restore:user-a']);
  });
});

describe('限流：账号被盗后不能无限造版本', () => {
  it('触发限流时返回 429，服务函数和审计都不发', async () => {
    store(memoryDto({ content: '我在用 Next.js 14' }));
    db.limiterOk = false;

    const patch = await call('PATCH', '/mem-1', { content: '我在用 Next.js 15', reason: '再改' });
    const retract = await call('POST', '/mem-1/retract', { reason: '别记' });

    expect(patch.response.status).toBe(429);
    expect(patch.payload.error.code).toBe('RATE_LIMITED');
    expect(retract.response.status).toBe(429);
    expect(db.reviseCalls).toEqual([]);
    expect(db.retractCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('限流桶按 session 用户分，不认请求体里的 userId', async () => {
    store(memoryDto({ content: '我在用 Next.js 14' }));

    await call('PATCH', '/mem-1', { content: '我在用 Next.js 15', reason: '改一下', userId: 'user-b' });

    expect(db.limiterCalls[0].key).toBe('memory-revise:user-a');
  });
});

/**
 * ④a 永久删除（任务书 7.2 DELETE、7.3 用户遗忘功能、7.4 门槛 2）。
 *
 * 服务层的删行与摘边在 cognitive-forgetting.test.ts 里测过，这里钉的是路由这一层：
 * 身份只能来自 session、限流挡在删之前、审计答得出「删了什么 kinds、几条」却一个字的正文都没有。
 */
describe('永久删除一条', () => {
  it('删掉自己的记忆，返回条数并写审计', async () => {
    store(memoryDto());

    const { response, payload } = await call('DELETE', '/mem-1');

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({ purged: 1, learned: [] });
    expect(db.purgeCalls).toEqual([{ id: 'mem-1', userId: 'user-a' }]);
    expect(db.stored.size).toBe(0);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: 'user.memory_purge',
      targetType: 'memory',
      targetId: 'mem-1',
      actorId: 'user-a'
    });
  });

  it('审计里记下类型、情境和版本，但没有任何正文', async () => {
    store(memoryDto({ content: '我在用 Prisma' }));

    await call('DELETE', '/mem-1');

    const written = JSON.stringify(db.audits[0]);
    expect(written).not.toContain('我在用 Prisma');
    expect(db.audits[0].before).toMatchObject({ type: 'project', context: 'technicalProject', version: 1 });
  });

  it('别人的记忆删不动：404，且一次删除都不发', async () => {
    store(memoryDto({ userId: 'user-b' }));

    const { response, payload } = await call('DELETE', '/mem-1');

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('MEMORY_NOT_FOUND');
    expect(db.purgeCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('未登录时 401，不查也不删', async () => {
    db.authThrows = true;
    store(memoryDto());

    const { response } = await call('DELETE', '/mem-1');

    expect(response.status).toBe(401);
    expect(db.getCalls).toEqual([]);
    expect(db.purgeCalls).toEqual([]);
  });

  it('触发限流时 429，删除和审计都不发', async () => {
    store(memoryDto());
    db.limiterOk = false;

    const { response, payload } = await call('DELETE', '/mem-1');

    expect(response.status).toBe(429);
    expect(payload.error.code).toBe('RATE_LIMITED');
    expect(db.purgeCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it('限流桶按 session 用户分，且和改口、撤回各自独立', async () => {
    store(memoryDto());

    await call('DELETE', '/mem-1');

    expect(db.limiterCalls[0].key).toBe('memory-purge:user-a');
  });
});

describe('批量永久删除', () => {
  beforeEach(() => {
    store(memoryDto({ id: 'mem-1', chatId: 'chat-1' }));
    store(memoryDto({ id: 'mem-2', chatId: 'chat-1' }));
    store(memoryDto({ id: 'mem-3', chatId: 'chat-2' }));
    store(memoryDto({ id: 'mem-4', userId: 'user-b', chatId: 'chat-1' }));
  });

  it('scope=all 清空自己的全部记忆，别人的不动', async () => {
    const { response, payload } = await call('DELETE', '', undefined, '?scope=all');

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({ purged: 3, learned: [] });
    expect(db.purgeAllCalls).toEqual(['user-a']);
    expect([...db.stored.keys()]).toEqual(['user-b|mem-4']);
    expect(db.audits[0]).toMatchObject({ action: 'user.memory_purge_all', targetId: 'user-a' });
  });

  it('scope=chat 只删那一次对话产生的，对话本身不碰', async () => {
    const { payload } = await call('DELETE', '', undefined, '?scope=chat&chatId=chat-1');

    expect(payload.data).toEqual({ purged: 2, learned: [] });
    expect(db.purgeChatCalls).toEqual([{ chatId: 'chat-1', userId: 'user-a' }]);
    expect([...db.stored.keys()].sort()).toEqual(['user-a|mem-3', 'user-b|mem-4']);
    expect(db.audits[0]).toMatchObject({ action: 'user.memory_purge_by_chat', targetType: 'chat', targetId: 'chat-1' });
  });

  it('scope=chat 缺 chatId 时 400，一次删除都不发', async () => {
    const { response, payload } = await call('DELETE', '', undefined, '?scope=chat');

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(db.purgeChatCalls).toEqual([]);
    expect(db.purgeAllCalls).toEqual([]);
  });

  it('scope 取值非法时 400', async () => {
    const { response } = await call('DELETE', '', undefined, '?scope=everything');

    expect(response.status).toBe(400);
    expect(db.purgeAllCalls).toEqual([]);
  });

  it('chatId 从查询串来，但只能删到自己的行：塞别人的会话 id 也只按 session 用户过滤', async () => {
    const { payload } = await call('DELETE', '', undefined, '?scope=chat&chatId=chat-9');

    expect(payload.data).toEqual({ purged: 0, learned: [] });
    expect(db.purgeChatCalls).toEqual([{ chatId: 'chat-9', userId: 'user-a' }]);
    expect(db.stored.size).toBe(4);
  });

  it('清空和按会话各自一个限流桶，触发限流时一条都不删', async () => {
    db.limiterOk = false;

    const all = await call('DELETE', '', undefined, '?scope=all');
    const byChat = await call('DELETE', '', undefined, '?scope=chat&chatId=chat-1');

    expect(all.response.status).toBe(429);
    expect(byChat.response.status).toBe(429);
    expect(db.purgeAllCalls).toEqual([]);
    expect(db.purgeChatCalls).toEqual([]);
    expect(db.stored.size).toBe(4);
  });

  it('两个批量口子的限流桶互不干扰', async () => {
    await call('DELETE', '', undefined, '?scope=all');
    db.purgeAllCalls = [];
    await call('DELETE', '', undefined, '?scope=chat&chatId=chat-2');

    expect(db.limiterCalls.map((entry) => entry.key)).toEqual([
      'memory-purge-all:user-a',
      'memory-purge-chat:user-a'
    ]);
  });

  it('未登录时 401，不删也不写审计', async () => {
    db.authThrows = true;

    const { response } = await call('DELETE', '', undefined, '?scope=all');

    expect(response.status).toBe(401);
    expect(db.purgeAllCalls).toEqual([]);
    expect(db.audits).toEqual([]);
  });
});

/**
 * ② 删除之后跑一次策略学习（任务书 1.3）。
 * 学习必须在删除提交之后：证据要先落库才数得到；学习失败也不许让删除失败，
 * 行已经删掉了，那是用户要的结果，不能因为附带效果报错就把 200 变成 500。
 */
describe('删除之后触发策略学习', () => {
  it('单条删除把该记忆的情境交给学习层，收紧结果回给前端', async () => {
    store(memoryDto());
    db.learned = ['technicalProject'];

    const { payload } = await call('DELETE', '/mem-1');

    expect(db.learnCalls).toEqual([{ userId: 'user-a', contexts: ['technicalProject'] }]);
    expect(payload.data).toEqual({ purged: 1, learned: ['technicalProject'] });
  });

  it('按会话删除把去重后的情境都交给学习层', async () => {
    store(memoryDto({ id: 'mem-1', chatId: 'chat-1', context: 'technicalProject' }));
    store(memoryDto({ id: 'mem-2', chatId: 'chat-1', context: 'general' }));

    await call('DELETE', '', undefined, '?scope=chat&chatId=chat-1');

    expect(db.learnCalls).toHaveLength(1);
    expect([...(db.learnCalls[0]?.contexts ?? [])].sort()).toEqual(['general', 'technicalProject']);
  });

  it('清空全部时学习层收到空数组：一次重置不该收紧任何情境', async () => {
    store(memoryDto({ id: 'mem-1' }));

    await call('DELETE', '', undefined, '?scope=all');

    expect(db.learnCalls).toEqual([{ userId: 'user-a', contexts: [] }]);
  });

  it('限流挡下时连学习都不跑', async () => {
    store(memoryDto());
    db.limiterOk = false;

    await call('DELETE', '/mem-1');

    expect(db.learnCalls).toEqual([]);
  });

  it('404 时不跑学习', async () => {
    const { response } = await call('DELETE', '/mem-404');

    expect(response.status).toBe(404);
    expect(db.learnCalls).toEqual([]);
  });

  it('审计里记下被自动收紧的情境，方便事后查这次删除改了什么', async () => {
    store(memoryDto());
    db.learned = ['technicalProject'];

    await call('DELETE', '/mem-1');

    expect(db.audits[0].after).toMatchObject({ purged: 1, learned: ['technicalProject'] });
  });
});

/**
 * 1a 置信度旁表（任务书 2.2）。
 * 和 chats 一样做成旁表而不是塞进每条记忆：MemoryDto 是服务层的形状，
 * 不该为了一个界面在这里编字段。
 *
 * 对外只给档位和因子，不给分数——一个三位小数会被当成精确真理，而它只是规则的产物。
 */
describe('记忆列表带置信度', () => {
  it('按记忆 id 给出档位和因子，不给分数', async () => {
    store(memoryDto({ id: 'mem-1' }));
    db.confidence.set('mem-1', {
      score: 0.84,
      band: 'high',
      factors: [{ kind: 'origin', origin: 'explicit' }, { kind: 'restated', count: 3 }]
    });

    const { payload } = await call('GET');

    expect(payload.data.confidence).toEqual({
      'mem-1': { band: 'high', factors: [{ kind: 'origin', origin: 'explicit' }, { kind: 'restated', count: 3 }] }
    });
    expect(JSON.stringify(payload.data.confidence)).not.toContain('0.84');
  });

  it('只给列表里的记忆算分，一次调用', async () => {
    store(memoryDto({ id: 'mem-1' }));
    store(memoryDto({ id: 'mem-2' }));

    await call('GET');

    expect(db.assessCalls).toHaveLength(1);
    expect(db.assessCalls[0]?.ids).toEqual(['mem-1', 'mem-2']);
  });

  it('没有记忆时不去算置信度', async () => {
    await call('GET');

    expect(db.assessCalls).toEqual([]);
  });

  it('未登录时不算置信度', async () => {
    db.authThrows = true;
    store(memoryDto({ id: 'mem-1' }));

    await call('GET');

    expect(db.assessCalls).toEqual([]);
  });
});

/**
 * 1b 一条记忆的证据（任务书 2.2 的支持证据 / 反对证据要能被用户自己看到）。
 * 和版本链同一个模式：不在列表里一次带回来，点一次取一条记忆的，
 * 每一次解密都对应一个真实的用户动作。
 */
describe('一条记忆的证据', () => {
  it('返回自己的证据，userId 取自 session', async () => {
    db.evidenceRows = [{ id: 'ev-1', kind: 'supports', origin: 'explicit' }];

    const { response, payload } = await call('GET', '/mem-1/evidence');

    expect(response.status).toBe(200);
    expect(payload.data.evidence).toEqual(db.evidenceRows);
    expect(db.evidenceCalls).toEqual([{ memoryId: 'mem-1', userId: 'user-a' }]);
  });

  it('未登录时 401，一次查询都不发', async () => {
    db.authThrows = true;

    const { response } = await call('GET', '/mem-1/evidence');

    expect(response.status).toBe(401);
    expect(db.evidenceCalls).toEqual([]);
  });

  it('还没有证据时返回空数组而不是 404：这张表之前根本不存在，老记忆一条账都没记', async () => {
    const { response, payload } = await call('GET', '/mem-1/evidence');

    expect(response.status).toBe(200);
    expect(payload.data.evidence).toEqual([]);
  });

  it('随便塞一个 id 也只按 session 用户查，探不出别人的记忆存不存在', async () => {
    const { response } = await call('GET', '/whatever/evidence');

    expect(response.status).toBe(200);
    expect(db.evidenceCalls).toEqual([{ memoryId: 'whatever', userId: 'user-a' }]);
  });
});
