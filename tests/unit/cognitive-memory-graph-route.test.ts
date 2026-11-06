import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 记忆网络接口（任务书 8.2 那一屏的后端）。只读，没有写入口。
 *
 * 派生逻辑本身在 cognitive-memory-graph.test.ts 里逐条钉过，这里钉的是路由这一层的五个决定：
 * 一、身份只来自 session——查询串里的 userId 换不掉归属；
 * 二、闸门是 `associationEnabled` **且** `memoryEnabled`，关着时一次记忆查询都不发。
 *     第一道管「这一屏开不开」，第二道管「能不能读记忆正文」：图是长期记忆的派生视图，
 *     它不许成为绕过长期记忆开关的后门（任务书 1.1「关闭模块后不能继续执行对应的数据读取」）。
 * 三、三批关系都要真的传给派生层。漏掉引用边那一读，图上就永远没有第三种线，
 *     而界面上那句「同一条洞察里一起提到」会变成装饰；
 * 四、偏好读不出来时按关闭处理，和时间线、manager.ts 的 `enabledModules` 同一个口径；
 * 五、回到浏览器的只有图本身：没有密文、没有演化理由、没有洞察的正文。
 */
const db = vi.hoisted(() => ({
  authThrows: false,
  associationEnabled: false,
  timelineEnabled: false,
  memoryEnabled: false,
  preferencesThrows: false,
  preferencesCalls: [] as string[],
  policyCalls: [] as string[],
  policiesThrows: false,
  /** null = 用应用里那份默认策略表；用例只在要改 `allowAssociation` 那一列时才自己造一张。 */
  policies: null as Record<string, unknown> | null,
  listCalls: Array<{ userId: string; filters: unknown }>(),
  edgeCalls: [] as string[],
  citationCalls: [] as string[],
  relationCalls: [] as Array<{ userId: string; memoryIds: string[] }>,
  relations: [] as Array<Record<string, unknown>>,
  titleCalls: Array<{ userId: string; chatIds: Array<string | null> }>(),
  memories: [] as Array<Record<string, unknown>>,
  edges: [] as Array<Record<string, unknown>>,
  citations: [] as Array<Record<string, unknown>>
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
    return Promise.resolve({
      associationEnabled: db.associationEnabled,
      timelineEnabled: db.timelineEnabled,
      memoryEnabled: db.memoryEnabled
    });
  }
}));

vi.mock('@/lib/cognitive/policy', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/cognitive/policy')>();
  return {
    ...actual,
    getMemoryPolicies: (userId: string) => {
      db.policyCalls.push(userId);
      if (db.policiesThrows) return Promise.reject(new Error('数据库连接中断'));
      return Promise.resolve((db.policies ?? actual.DEFAULT_MEMORY_POLICIES) as never);
    }
  };
});

vi.mock('@/lib/cognitive/memories', () => ({
  listMemories: (userId: string, filters?: unknown) => {
    db.listCalls.push({ userId, filters });
    return Promise.resolve(db.memories.filter((row) => row.userId === userId));
  },
  listRevisionEdges: (userId: string) => {
    db.edgeCalls.push(userId);
    return Promise.resolve(db.edges);
  },
  listCitationEdges: (userId: string) => {
    db.citationCalls.push(userId);
    return Promise.resolve(db.citations);
  }
}));

vi.mock('@/lib/cognitive/relations', () => ({
  listRelationsForGraph: (userId: string, memoryIds: string[]) => {
    db.relationCalls.push({ userId, memoryIds });
    return Promise.resolve(db.relations.filter((row) => row.userId === userId));
  }
}));

vi.mock('@/lib/chats', () => ({
  listChatTitles: (userId: string, chatIds: Array<string | null>) => {
    db.titleCalls.push({ userId, chatIds });
    return Promise.resolve(
      Object.fromEntries(chatIds.filter((id): id is string => Boolean(id)).map((id) => [id, `标题 ${id}`]))
    );
  }
}));

const BASE = 'http://127.0.0.1:3000/api/account/cognitive/graph';

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
  const route = await import('@/app/api/account/cognitive/graph/route');
  const response = await route.GET(new Request(`${BASE}${query}`, { headers: { origin: 'http://127.0.0.1:3000' } }));
  return { response, payload: await response.json() };
}

beforeEach(() => {
  db.authThrows = false;
  db.associationEnabled = true;
  db.timelineEnabled = true;
  db.memoryEnabled = true;
  db.preferencesThrows = false;
  db.preferencesCalls = [];
  db.policyCalls = [];
  db.policiesThrows = false;
  db.policies = null;
  db.listCalls = [];
  db.edgeCalls = [];
  db.citationCalls = [];
  db.relationCalls = [];
  db.relations = [];
  db.titleCalls = [];
  db.memories = [];
  db.edges = [];
  db.citations = [];
});

describe('闸门：开关关掉是真的不读', () => {
  it('未登录时 401，连偏好都不查', async () => {
    db.authThrows = true;

    const { response } = await call();

    expect(response.status).toBe(401);
    expect(db.preferencesCalls).toEqual([]);
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
    expect(db.citationCalls).toEqual([]);
  });

  it('associationEnabled 关着时返回 MODULE_DISABLED，一次记忆查询都不发', async () => {
    db.associationEnabled = false;
    db.memories = [memoryRow()];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
    expect(db.citationCalls).toEqual([]);
    expect(db.titleCalls).toEqual([]);
  });

  it('关联开着但长期记忆关着时也不许读：图是它的派生视图，不能当后门', async () => {
    db.associationEnabled = true;
    db.memoryEnabled = false;
    db.memories = [memoryRow()];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(payload.error.message).toContain('长期记忆');
    expect(db.listCalls).toEqual([]);
    expect(db.edgeCalls).toEqual([]);
    expect(db.citationCalls).toEqual([]);
  });

  it('偏好读不出来时按关闭处理：拿不准就不读用户的记忆', async () => {
    db.preferencesThrows = true;
    db.memories = [memoryRow()];

    const { response, payload } = await call();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('MODULE_DISABLED');
    expect(db.listCalls).toEqual([]);
  });

  it('两道闸门一次请求只读一遍偏好', async () => {
    db.memories = [memoryRow()];

    const { response } = await call();

    expect(response.status).toBe(200);
    expect(db.preferencesCalls).toEqual(['user-a']);
  });
});

describe('策略表：这一屏是 allowAssociation 唯一的运行时读者', () => {
  it('闸门关着时连策略表都不读：这一屏不开，就没有必要知道七行策略', async () => {
    db.associationEnabled = false;
    db.memories = [memoryRow()];

    const { response } = await call();

    expect(response.status).toBe(409);
    expect(db.policyCalls).toEqual([]);
    expect(db.listCalls).toEqual([]);
  });

  it('闸门开着时读一次，读的是 session 用户自己的：查询串里的 userId 换不掉它', async () => {
    db.memories = [memoryRow()];

    const { response } = await call('?userId=user-b');

    expect(response.status).toBe(200);
    expect(db.policyCalls).toEqual(['user-a']);
  });

  it('策略表真的交给了派生层：关掉关联的那个情境不做共引用的锚点', async () => {
    // mem-1 落在 emotionalSupport（默认表里 allowAssociation 就是关的），另外两条在开着的情境里。
    db.memories = [
      memoryRow({ id: 'mem-1', context: 'emotionalSupport', chatId: null }),
      memoryRow({ id: 'mem-2', chatId: null, recordedAt: '2026-11-03T10:00:00.000Z' }),
      memoryRow({ id: 'mem-3', chatId: null, recordedAt: '2026-11-04T10:00:00.000Z' })
    ];
    db.citations = [
      { reflectionId: 'ref-1', memoryId: 'mem-1' },
      { reflectionId: 'ref-1', memoryId: 'mem-2' },
      { reflectionId: 'ref-1', memoryId: 'mem-3' }
    ];

    const { payload } = await call();

    expect(payload.data.edges).toEqual([{ from: 'mem-2', to: 'mem-3', kind: 'coCitation' }]);
    expect(payload.data.associationGated).toBe(1);
  });

  it('associationGated 原样透出：界面那句「有几条按策略没连线」说的是这个数，不是它自己数的', async () => {
    db.memories = [memoryRow({ id: 'mem-1', context: 'personalReflection' })];

    const { payload } = await call();

    expect(payload.data.associationGated).toBe(1);
  });

  /**
   * 这一条是这一片最容易被写歪的地方：`try { policies = await ... } catch { policies = 全开 }`
   * 看起来最「不影响用户」，实际是把用户明确关掉的闸门在读取失败时打开了。
   * 所以这里要的是报错——和 `memory-module.ts` 读不到保留期就整模块失败同一个口径。
   */
  it('策略表读不出来时报错，不许当成「全都允许」把用户挡掉的线画出来', async () => {
    db.policiesThrows = true;
    db.memories = [memoryRow({ id: 'mem-1' }), memoryRow({ id: 'mem-2', chatId: 'chat-2' })];

    const { response, payload } = await call();

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.data).toBeUndefined();
  });
});

describe('读：三批关系都要给到派生层', () => {
  it('记忆行、演化边、共引用边各读一次，读的都是 session 用户自己的', async () => {
    db.memories = [
      memoryRow({ id: 'mem-1', content: '甲' }),
      memoryRow({ id: 'mem-2', chatId: 'chat-2', content: '乙' }),
      memoryRow({ id: 'mem-3', chatId: 'chat-3', content: '丙' }),
      memoryRow({ userId: 'user-b', id: 'mem-9', content: '别人家的记忆' })
    ];
    db.citations = [
      { reflectionId: 'ref-1', memoryId: 'mem-1' },
      { reflectionId: 'ref-1', memoryId: 'mem-2' }
    ];

    const { payload } = await call();

    expect(db.listCalls[0]).toMatchObject({ userId: 'user-a', filters: { includeSuperseded: true } });
    expect(db.edgeCalls).toEqual(['user-a']);
    expect(db.citationCalls).toEqual(['user-a']);
    expect(payload.data.nodes.map((n: { id: string }) => n.id)).toEqual(['mem-1', 'mem-2', 'mem-3']);
  });

  it('共引用边真的进了图：漏掉这一读，「同一条洞察里一起提到」那条线就永远画不出来', async () => {
    db.memories = [memoryRow({ id: 'mem-1' }), memoryRow({ id: 'mem-2', chatId: null }), memoryRow({ id: 'mem-3', chatId: null })];
    db.citations = [
      { reflectionId: 'ref-1', memoryId: 'mem-2' },
      { reflectionId: 'ref-1', memoryId: 'mem-3' }
    ];

    const { payload } = await call();

    expect(payload.data.edges).toContainEqual({ from: 'mem-2', to: 'mem-3', kind: 'coCitation' });
  });

  it('查询串里的 userId 换不掉归属：多一个参数也不多查一行', async () => {
    db.memories = [memoryRow()];

    await call('?userId=user-b&context=learning');

    expect(db.listCalls[0].userId).toBe('user-a');
    expect(db.citationCalls).toEqual(['user-a']);
  });
});

describe('回给浏览器的只有图', () => {
  it('节点只带画布用得上的那几列：没有密文', async () => {
    db.memories = [memoryRow({ contentCiphertext: 'MIGf...base64...', embeddingCiphertext: 'BLOB' })];

    const { payload } = await call();

    expect(payload.data.nodes).toEqual([
      {
        id: 'mem-1',
        content: '我在用 Prisma',
        type: 'project',
        context: 'technicalProject',
        chatId: 'chat-1',
        isCurrent: true,
        recordedAt: '2026-11-02T10:00:00.000Z'
      }
    ]);
    expect(JSON.stringify(payload.data)).not.toContain('MIGf');
    expect(JSON.stringify(payload.data)).not.toContain('BLOB');
  });

  it('会话标题做成旁表：节点上不挂标题，同一场对话只问一次', async () => {
    db.memories = [
      memoryRow({ id: 'mem-1', chatId: 'chat-1' }),
      memoryRow({ id: 'mem-2', chatId: 'chat-2', recordedAt: '2026-11-03T10:00:00.000Z' }),
      memoryRow({ id: 'mem-3', chatId: 'chat-1', recordedAt: '2026-11-04T10:00:00.000Z' }),
      memoryRow({ id: 'mem-4', chatId: null, recordedAt: '2026-11-05T10:00:00.000Z' })
    ];

    const { payload } = await call();

    expect(db.titleCalls[0]).toEqual({ userId: 'user-a', chatIds: ['chat-1', 'chat-2'] });
    expect(payload.data.chats).toEqual({ 'chat-1': '标题 chat-1', 'chat-2': '标题 chat-2' });
    expect(payload.data.nodes.every((node: { title?: string }) => node.title === undefined)).toBe(true);
  });

  it('截断的两条标记原样透出，界面才知道要不要说「画不全」', async () => {
    db.memories = [memoryRow()];

    const { payload } = await call();

    expect(payload.data.capped).toEqual({ nodes: false, edges: false });
    expect(payload.data.totalNodes).toBe(1);
    expect(payload.data.totalEdges).toBe(0);
  });

  it('一行记忆都没有时返回空图，不报错', async () => {
    const { response, payload } = await call();

    expect(response.status).toBe(200);
    expect(payload.data.nodes).toEqual([]);
    expect(payload.data.edges).toEqual([]);
    expect(payload.data.groups).toEqual([]);
    expect(db.titleCalls).toEqual([]);
  });
});

describe('库里的关系行也进图（片O）', () => {
  it('按节点集合向 session 用户取关系，并画成 relation 线', async () => {
    db.memories = [memoryRow({ id: 'a' }), memoryRow({ id: 'b', content: '爬山要带相机' })];
    db.relations = [{ userId: 'user-a', sourceMemoryId: 'a', targetMemoryId: 'b', relationType: 'SAME_TOPIC' }];

    const { response, payload } = await call();

    expect(response.status).toBe(200);
    expect(db.relationCalls).toEqual([{ userId: 'user-a', memoryIds: ['a', 'b'] }]);
    expect(payload.data.edges).toEqual([{ from: 'a', to: 'b', kind: 'relation' }]);
  });
});
