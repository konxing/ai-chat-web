import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 变化检测接口（任务书 4.3 那一屏的后端）。只读，没有写入口。
 *
 * 规则本身在 `cognitive-change-detector.test.ts` 里逐条钉过，这里只钉路由这一层的五个决定：
 * 一、闸门与时间线同一对（`timelineEnabled` + `memoryEnabled`），关掉是真的不读一行记忆；
 * 二、`now` 由服务端注入：请求体、查询串都不许改它——改了就能把 60 天的门槛拨开；
 * 三、回给浏览器的观察结构里没有正文，正文走旁表 `sources`；
 * 四、旁表只装被引到的行，没被引到的记忆一行都不回；
 * 五、上限那一列在变化这边同样成立：没读进来的更老历史不等于没发生过。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  timelineEnabled: false,
  memoryEnabled: false,
  preferencesThrows: false,
  preferencesCalls: [] as string[],
  listCalls: [] as Array<{ userId: string; filters: unknown }>,
  edgeCalls: [] as string[],
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
 * 变化检测在运行时要它们，而在测试里手写一份映射就是给同一套枚举造第二把尺子——
 * 替身和真库哪天不一致，测过的就只是替身。
 */
vi.mock('@/lib/cognitive/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/memories')>();
  return {
    ...actual,
    MEMORY_LIST_MAX_ROWS: 2,
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

const BASE = 'http://127.0.0.1:3000/api/account/cognitive/changes';

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-a',
    id: 'old',
    chatId: 'chat-1',
    sourceMessageId: 'msg-old',
    type: 'preference',
    context: 'general',
    origin: 'explicit',
    content: '我习惯晚上写代码',
    confirmedAt: null,
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: '2026-10-20T10:00:00.000Z',
    recordedAt: '2026-09-01T10:00:00.000Z',
    ...overrides
  };
}

const NEW_ROW = {
  id: 'new',
  chatId: 'chat-2',
  sourceMessageId: 'msg-new',
  content: '我习惯早上写代码',
  supersededAt: null,
  recordedAt: '2026-10-21T10:00:00.000Z'
};

const SUPERSEDED_EDGE = { memoryId: 'new', previousId: 'old', action: 'superseded', createdAt: '2026-10-20T10:00:00.000Z' };

async function call(query = '') {
  const route = await import('@/app/api/account/cognitive/changes/route');
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
    db.memories = [memoryRow(), memoryRow(NEW_ROW)];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
  });

  it('开关读不出来时按关闭处理：拿不准就不读用户的记忆', async () => {
    db.preferencesThrows = true;
    db.memories = [memoryRow(), memoryRow(NEW_ROW)];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(db.listCalls).toEqual([]);
  });

  it('memoryEnabled 关着时 409：变化检测不能成为绕过长期记忆开关的后门', async () => {
    db.memoryEnabled = false;
    db.memories = [memoryRow(), memoryRow(NEW_ROW)];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.message).toBe('长期记忆没有打开；变化检测是它的派生视图，关掉后这里不读取记忆内容');
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
  });

  it('两个开关都打开时才放行，且一次请求只读一遍偏好', async () => {
    db.memories = [memoryRow(), memoryRow(NEW_ROW)];
    db.edges = [SUPERSEDED_EDGE];

    const { response } = await call();

    expect(response.status).toBe(200);
    expect(db.preferencesCalls).toEqual(['user-a']);
  });
});

describe('时间只来自服务端', () => {
  /** 冻结真实时刻：这一条测的是「客户端传的时间不起作用」，不该几天后自己变红。 */
  it('查询串里的 now 改不动门槛：拨一个未来日期也不会多出一条「放了很久」', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'));
    db.memories = [
      memoryRow({
        id: 'goal-1',
        type: 'goal',
        content: '我打算今年跑完半马',
        supersededAt: null,
        recordedAt: '2026-10-20T10:00:00.000Z'
      })
    ];

    try {
      const { payload } = await call('?now=2027-01-01T00:00:00.000Z&userId=user-b');

      // 真实时刻下这条目标才放了半个月，够不上 60 天——它只能以「放下的时间还不够久」出现。
      expect(payload.data.observations).toEqual([]);
      expect(payload.data.insufficient).toEqual([
        { subject: 'UNRESOLVED', reason: 'BELOW_AGE_MIN', sampleCount: 1, observationSpanDays: 0 }
      ]);
      expect(db.listCalls[0]?.userId).toBe('user-a');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('读：观察不带正文，正文走旁表', () => {
  it('一条跨会话的改口就是一条观察，样本数和跨度跟着它', async () => {
    db.memories = [memoryRow(), memoryRow(NEW_ROW)];
    db.edges = [SUPERSEDED_EDGE];

    const { response, payload } = await call();

    expect(response.status).toBe(200);
    expect(payload.data.observations).toEqual([
      {
        subject: 'PREFERENCE',
        change: 'CHANGED',
        topicTokens: expect.any(Array),
        beforeMemoryIds: ['old'],
        afterMemoryIds: ['new'],
        sampleCount: 2,
        observationSpanDays: 50,
        firstSeenAt: '2026-09-01T10:00:00.000Z',
        lastSeenAt: '2026-10-21T10:00:00.000Z',
        timePrecision: 'TIMESTAMP',
        confirmed: true
      }
    ]);
  });

  it('读的是含被取代版本的整批记忆，且归属只来自 session', async () => {
    db.memories = [memoryRow(), memoryRow(NEW_ROW), memoryRow({ userId: 'user-b', id: 'mem-9' })];
    db.edges = [SUPERSEDED_EDGE];

    await call('?userId=user-b');

    expect(db.listCalls[0]).toMatchObject({ userId: 'user-a', filters: { includeSuperseded: true } });
    expect(db.edgeCalls).toEqual(['user-a']);
  });

  it('旁表只装被引到的两行，别人的行和没被引到的行都不回', async () => {
    db.memories = [
      memoryRow(),
      memoryRow(NEW_ROW),
      memoryRow({ userId: 'user-b', id: 'mem-9', content: '别人家的记忆' }),
      memoryRow({ id: 'uncited', chatId: 'chat-9', content: '同一件事之外的另一句', supersededAt: null })
    ];
    db.edges = [SUPERSEDED_EDGE];

    const { payload } = await call();

    expect(payload.data.sources).toEqual({ old: '我习惯晚上写代码', new: '我习惯早上写代码' });
    expect(JSON.stringify(payload.data.observations)).not.toContain('我习惯');
  });

  it('观察结构里没有密文，也没有演化理由', async () => {
    db.memories = [memoryRow({ contentCiphertext: 'MIGf...base64...' }), memoryRow({ ...NEW_ROW, reasonCiphertext: 'MII...' })];
    db.edges = [{ ...SUPERSEDED_EDGE, reasonCiphertext: 'MII...' }];

    const { payload } = await call();

    expect(JSON.stringify(payload.data)).not.toContain('MIGf');
    expect(JSON.stringify(payload.data)).not.toContain('MII');
  });

  it('一行记忆都没有时返回空结果，不报错', async () => {
    const { response, payload } = await call();

    expect(response.status).toBe(200);
    expect(payload.data.observations).toEqual([]);
    expect(payload.data.insufficient).toEqual([]);
    expect(payload.data.sources).toEqual({});
    expect(payload.data.capped).toBe(false);
  });

  it('读到上限时 capped 为真：更老的历史没被读进来', async () => {
    db.memories = [memoryRow(), memoryRow(NEW_ROW)];
    db.edges = [SUPERSEDED_EDGE];

    const { payload } = await call();

    expect(payload.data.capped).toBe(true);
  });
});
