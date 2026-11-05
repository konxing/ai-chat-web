import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 认知时间线接口（任务书 4.4 那一屏的后端）。
 *
 * 派生逻辑本身在 cognitive-timeline.test.ts 里逐条钉过，这里只钉路由这一层的四个决定：
 * 一、身份只来自 session；
 * 二、`timelineEnabled` 关掉时**一次记忆查询都不发**——任务书要求开关在服务端强制，
 *     「服务端读出来再让界面自己不显示」不算强制；
 * 三、演化边要真的传给派生层，忘了传就等于把历史版本摊成一堆独立事件；
 * 四、回到浏览器的只有事件本身，没有密文、没有演化理由。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  timelineEnabled: false,
  memoryEnabled: false,
  preferencesThrows: false,
  preferencesCalls: [] as string[],
  listCalls: [] as Array<{ userId: string; filters: unknown }>,
  edgeCalls: [] as string[],
  titleCalls: [] as Array<{ userId: string; chatIds: Array<string | null> }>,
  memories: [] as Array<Record<string, unknown>>,
  edges: [] as Array<Record<string, unknown>>
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
  getCognitivePreferences: (userId: string) => {
    db.preferencesCalls.push(userId);
    if (db.preferencesThrows) return Promise.reject(new Error('数据库连接中断'));
    return Promise.resolve({ timelineEnabled: db.timelineEnabled, memoryEnabled: db.memoryEnabled });
  }
}));

/**
 * 只替掉两个 I/O 函数，枚举转换（`toDbMemoryType` 那一组）用真模块：
 * 4.1 的类别要经 4.3 的观察，而观察在运行时要那些转换——在测试里手写一份映射
 * 就是给同一套枚举造第二把尺子，替身和真库哪天不一致，测过的就只是替身。
 */
vi.mock('@/lib/cognitive/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/memories')>();
  return {
    ...actual,
    MEMORY_LIST_MAX_ROWS: 5,
    listMemories: (userId: string, filters?: unknown) => {
      db.listCalls.push({ userId, filters });
      return Promise.resolve(db.memories.filter((row) => row.userId === userId));
    },
    listRevisionEdges: (userId: string) => {
      db.edgeCalls.push(userId);
      return Promise.resolve(db.edges);
    }
  };
});

vi.mock('@/lib/chats', () => ({
  listChatTitles: (userId: string, chatIds: Array<string | null>) => {
    db.titleCalls.push({ userId, chatIds });
    return Promise.resolve(
      Object.fromEntries(chatIds.filter((id): id is string => Boolean(id)).map((id) => [id, `标题 ${id}`]))
    );
  }
}));

const BASE = 'http://127.0.0.1:3000/api/account/cognitive/timeline';

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-a',
    id: 'mem-1',
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

async function call(query = '') {
  const route = await import('@/app/api/account/cognitive/timeline/route');
  const response = await route.GET(new Request(`${BASE}${query}`, { headers: { origin: 'http://127.0.0.1:3000' } }));
  return { response, payload: await response.json() };
}

beforeEach(() => {
  db.authThrows = false;
  db.timelineEnabled = true;
  db.memoryEnabled = true;
  db.preferencesThrows = false;
  db.preferencesCalls = [];
  db.listCalls = [];
  db.edgeCalls = [];
  db.titleCalls = [];
  db.memories = [];
  db.edges = [];
});

describe('闸门：开关关掉是真的不读', () => {
  it('未登录时 401，连偏好都不查', async () => {
    db.authThrows = true;

    const { response } = await call();

    expect(response.status).toBe(401);
    expect(db.preferencesCalls).toEqual([]);
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
  });

  it('timelineEnabled 关着时返回 MODULE_DISABLED，一次记忆查询都不发', async () => {
    db.timelineEnabled = false;
    db.memories = [memoryRow()];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
    expect(db.titleCalls).toEqual([]);
  });

  it('开关读不出来时按关闭处理：拿不准就不读用户的记忆', async () => {
    db.preferencesThrows = true;
    db.memories = [memoryRow()];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(db.listCalls).toEqual([]);
  });
});

/**
 * 时间线是长期记忆的派生视图：`timelineEnabled` 开着、`memoryEnabled` 关着时，
 * 这一屏不许再读任何一行记忆内容（任务书 1.1「关闭模块后不能继续执行对应的数据读取」）。
 */
describe('memoryEnabled 关着时时间线也不读', () => {
  it('timelineEnabled 开着但 memoryEnabled 关着 ⇒ 409，一次记忆查询都不发', async () => {
    db.timelineEnabled = true;
    db.memoryEnabled = false;
    db.memories = [memoryRow()];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(payload.error.message).toBe('长期记忆没有打开；时间线是它的派生视图，关掉后这里不读取记忆内容');
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
    expect(db.titleCalls).toEqual([]);
  });

  it('两个开关都打开时才放行，且一次请求只读一遍偏好', async () => {
    db.memories = [memoryRow()];

    const { response } = await call();

    expect(response.status).toBe(200);
    expect(db.preferencesCalls).toEqual(['user-a']);
  });
});

describe('读：事件按时间排好，来源带标题', () => {
  it('打开时返回按时间从早到晚的事件，读的是 session 用户自己的记忆', async () => {
    db.memories = [
      memoryRow({ id: 'mem-1', content: '2025 年我离开了上一家公司', precision: 'year', validFrom: '2025-01-01T00:00:00.000Z' }),
      memoryRow({ id: 'mem-2', chatId: 'chat-2', content: '我现在在写家庭助手', recordedAt: '2026-11-02T10:00:00.000Z' }),
      memoryRow({ userId: 'user-b', id: 'mem-3', content: '别人家的记忆' })
    ];

    const { response, payload } = await call();

    expect(response.status).toBe(200);
    expect(db.listCalls[0]).toMatchObject({ userId: 'user-a', filters: { includeSuperseded: true } });
    expect(payload.data.events.map((event: { memoryId: string }) => event.memoryId)).toEqual(['mem-1', 'mem-2']);
    expect(payload.data.events[0].timeSource).toBe('validity');
    expect(payload.data.chats).toEqual({ 'chat-1': '标题 chat-1', 'chat-2': '标题 chat-2' });
  });

  it('查询串里的 userId 换不掉归属：多一个参数也不多查一行', async () => {
    db.memories = [memoryRow(), memoryRow({ userId: 'user-b', id: 'mem-9' })];

    await call('?userId=user-b&chatId=chat-9');

    expect(db.listCalls[0].userId).toBe('user-a');
    expect(db.titleCalls[0]).toEqual({ userId: 'user-a', chatIds: ['chat-1'] });
  });

  it('事件只带派生层算出来的那几列：没有密文，也没有演化理由', async () => {
    db.memories = [memoryRow({ contentCiphertext: 'MIGf...base64...' })];

    const { payload } = await call();

    expect(payload.data.events).toEqual([
      {
        memoryId: 'mem-1',
        category: 'project',
        kind: 'PROJECT_STARTED',
        content: '我在用 Prisma',
        context: 'technicalProject',
        origin: 'explicit',
        confirmedAt: '2026-11-02T10:00:00.000Z',
        precision: 'unknown',
        occurredAt: '2026-11-02T10:00:00.000Z',
        timeSource: 'recorded',
        validFrom: null,
        validTo: null,
        version: 1,
        historyCount: 0,
        chatId: 'chat-1',
        sourceMessageId: 'msg-1',
        recordedAt: '2026-11-02T10:00:00.000Z'
      }
    ]);
    expect(JSON.stringify(payload.data)).not.toContain('MIGf');
  });

  it('演化边真的交给派生层：被取代的旧说法折进同一事件，不占两个坑', async () => {
    db.memories = [
      memoryRow({ id: 'mem-1', content: '项目在从 MySQL 迁走', version: 2, supersededAt: '2026-11-02T10:00:00.000Z' }),
      memoryRow({ id: 'mem-2', content: '项目已经换到 PostgreSQL', version: 3, recordedAt: '2026-11-03T10:00:00.000Z' })
    ];
    db.edges = [{ memoryId: 'mem-2', previousId: 'mem-1', action: 'superseded', createdAt: '2026-11-03T10:00:00.000Z' }];

    const { payload } = await call();

    expect(db.edgeCalls).toEqual(['user-a']);
    expect(payload.data.events).toHaveLength(1);
    expect(payload.data.events[0]).toMatchObject({ memoryId: 'mem-2', version: 3, historyCount: 1 });
  });

  it('一行记忆都没有时返回空时间线，不报错', async () => {
    const { response, payload } = await call();

    expect(response.status).toBe(200);
    expect(payload.data.events).toEqual([]);
    expect(payload.data.capped).toBe(false);
  });

  /** 上限是 mock 里那个 5：真实现读回整满一批就意味着更老的历史被截掉了，界面必须能说出来。 */
  it('读到上限时 capped 为真：时间线只覆盖了最近这一批记忆', async () => {
    db.memories = Array.from({ length: 5 }, (_unused, index) =>
      memoryRow({ id: `mem-${index}`, recordedAt: `2026-11-0${(index % 9) + 1}T10:00:00.000Z` })
    );

    const { payload } = await call();

    expect(payload.data.events).toHaveLength(5);
    expect(payload.data.capped).toBe(true);
  });
});

/**
 * 任务书 4.1 的 EventExtractor 接在这一层。
 *
 * 规则本身在 `cognitive-event-extractor.test.ts` 里逐条钉过，这里只钉接线这四件事：
 * 一、类别是**内存里算出来的**：读的还是那两样（记忆行 + 演化边），一次查询都不多发；
 * 二、类别跟着折叠走——一条版本链在时间线上是一个事件，也就只有一个类别；
 * 三、「一段经历」是兜底而不是标签：`decision` 类型的行不冒充「一个决定」；
 * 四、这一列会随「现在」变：同一条记忆在 30 天窗口内是「新提起的事」，出了窗口就只是「一段经历」，
 *     所以这一组用例必须冻住时钟，否则它会自己某天变红。
 */
describe('事件类别（任务书 4.1）接在读侧派生层上', () => {
  function kinds(payload: { data: { events: Array<{ kind: string }> } }): string[] {
    return payload.data.events.map((event) => event.kind);
  }

  it('多出一列不多发一次查询：记忆、边、标题各读一遍', async () => {
    db.memories = [memoryRow()];

    const { payload } = await call();

    expect(payload.data.events[0].kind).toBe('PROJECT_STARTED');
    expect(db.listCalls).toHaveLength(1);
    expect(db.edgeCalls).toHaveLength(1);
    expect(db.titleCalls).toHaveLength(1);
  });

  it('改过口的目标是一个事件、一个类别：GOAL_CHANGED，旧说法不另占一条', async () => {
    db.memories = [
      memoryRow({ id: 'mem-1', type: 'goal', context: 'personalGoal', content: '我要考科目二', supersededAt: '2026-11-02T10:00:00.000Z' }),
      memoryRow({ id: 'mem-2', type: 'goal', context: 'personalGoal', content: '改成考科目三', version: 2, recordedAt: '2026-11-03T10:00:00.000Z' })
    ];
    db.edges = [{ memoryId: 'mem-2', previousId: 'mem-1', action: 'superseded', createdAt: '2026-11-03T10:00:00.000Z' }];

    const { payload } = await call();

    expect(payload.data.events).toHaveLength(1);
    expect(kinds(payload)).toEqual(['GOAL_CHANGED']);
  });

  it('决策类型的行落进「一段经历」：这一层没有确认状态，就不说「一个决定」', async () => {
    db.memories = [
      memoryRow({ id: 'mem-1', type: 'decision', content: '我选了 Prisma', confirmedAt: '2026-11-02T10:00:00.000Z' }),
      memoryRow({ id: 'mem-2', type: 'emotion', content: '我这阵子很累', recordedAt: '2026-11-03T10:00:00.000Z' })
    ];

    const { payload } = await call();

    expect(kinds(payload)).toEqual(['EXPERIENCE', 'EXPERIENCE']);
    const serialized = JSON.stringify(payload.data);
    for (const kind of ['DECISION_MADE', 'MILESTONE', 'CHALLENGE']) expect(serialized).not.toContain(kind);
  });

  it('30 天窗口内簇里的偏好是「新提起的事」，而同一簇里的第一版目标仍是「定下目标」', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'));
    db.memories = [
      memoryRow({ id: 'mem-1', type: 'preference', content: '我想学唱歌这件事', chatId: 'chat-1', recordedAt: '2026-10-20T00:00:00.000Z' }),
      memoryRow({ id: 'mem-2', type: 'goal', content: '我在练唱歌这件事', chatId: 'chat-2', recordedAt: '2026-10-26T00:00:00.000Z' }),
      memoryRow({ id: 'mem-3', type: 'preference', content: '我爱上唱歌这件事', chatId: 'chat-3', recordedAt: '2026-11-01T00:00:00.000Z' })
    ];

    try {
      const { payload } = await call();
      expect(kinds(payload)).toEqual(['INTEREST_EMERGED', 'GOAL_CREATED', 'INTEREST_EMERGED']);

      vi.setSystemTime(new Date('2027-06-01T00:00:00.000Z'));
      const later = await call();
      expect(kinds(later.payload)).toEqual(['EXPERIENCE', 'GOAL_CREATED', 'EXPERIENCE']);
    } finally {
      vi.useRealTimers();
    }
  });
});
