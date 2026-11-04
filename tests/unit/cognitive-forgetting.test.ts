import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@/lib/crypto';

/**
 * 永久删除（任务书 7.2 的 DELETE、7.3 的用户遗忘功能、7.4 门槛 2「派生数据按策略清理」）。
 *
 * 这里最难的一条不是删行，是删行之前先处理演化边：MemoryRevision.previousId 的外键是
 * ON DELETE CASCADE，直接删旧版本会把「新版本是改口来的」那条边一起带走，
 * 活着的那一行版本链就凭空断了。所以先把指向被删行的边摘开（previousId 置 null，
 * 该列本身可空），保住「这一版来自一次改口」这个事实，同时不留指向已删内容的指针。
 *
 * 派生数据当前有五种：演化边、排除规则、还没跑的认知任务（CognitiveTask）、
 * 引用了被删记忆的洞察行（ReflectionRecord + ReflectionCitation），以及某次对话产生的决策行
 * （DecisionRecord）。Embedding、图关系、时间线派生还没落地，等它们出现时这里要跟着加清理。
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  edges: [] as Row[],
  exclusions: [] as Row[],
  signals: [] as Row[],
  /** 还没跑的认知任务（CognitiveTask 行）。删除要连带把它们撤掉。 */
  tasks: [] as Row[],
  /** 洞察行、它的引用行、决策行、对话消息行：门槛 2 的派生清理要看这四张表。 */
  reflections: [] as Row[],
  citations: [] as Row[],
  decisions: [] as Row[],
  messages: [] as Row[],
  /** 每张表上一次 findMany 交回给代码的那批行——用它断言「只读了 id，没读正文」。 */
  returned: {} as Record<string, Row[]>,
  txOps: [] as string[],
  topOps: [] as string[],
  commits: 0,
  /** 策略学习层的开关（偏好表里的第八个）。null 表示「偏好读不出来」。 */
  adaptiveEnabled: true as boolean | null
}));

function satisfies(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== 'object') return value === condition;
  const c = condition as Record<string, unknown>;
  if ('in' in c) return (c.in as unknown[]).includes(value);
  return value === condition;
}

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where as Record<string, unknown>).every(([field, condition]) =>
    satisfies(row[field], condition)
  );
}

function matching(where: unknown): Row[] {
  return [...db.rows.values()].filter((row) => matches(row, where));
}

/** 数据库层的 ON DELETE CASCADE：memoryId 指向被删行的边一起消失，mock 必须照做。 */
function removeRows(ids: string[]): void {
  for (const id of ids) db.rows.delete(id);
  db.edges = db.edges.filter((edge) => !ids.includes(String(edge.memoryId)));
}

function deleteMany(where: unknown, sink: string[]): { count: number } {
  sink.push('delete');
  const ids = matching(where).map((row) => String(row.id));
  removeRows(ids);
  return { count: ids.length };
}

function detach(where: unknown, data: Row, sink: string[]): { count: number } {
  sink.push('detach');
  const rows = db.edges.filter((edge) => matches(edge, where));
  for (const row of rows) Object.assign(row, data);
  return { count: rows.length };
}

function exclusionClient(sink: string[]) {
  return {
    findMany: ({ where }: { where: unknown }) =>
      Promise.resolve(db.exclusions.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
    create: ({ data }: { data: Row }) => {
      sink.push('exclude');
      const row = { createdAt: new Date(), ...data };
      db.exclusions.push(row);
      return Promise.resolve(row);
    },
    count: ({ where }: { where: unknown }) =>
      Promise.resolve(db.exclusions.filter((row) => matches(row, where)).length),
    deleteMany: ({ where }: { where: unknown }) => {
      const rows = db.exclusions.filter((row) => matches(row, where));
      db.exclusions = db.exclusions.filter((row) => !rows.includes(row));
      return Promise.resolve({ count: rows.length });
    }
  };
}

function signalClient(sink: string[]) {
  return {
    create: ({ data }: { data: Row }) => {
      sink.push('signal');
      const row: Row = { createdAt: new Date(), ...data };
      db.signals.push(row);
      return Promise.resolve(row);
    }
  };
}

/** CognitiveTask 表。撤欠账必须走事务客户端，所以 sink 由调用方给。 */
function taskClient(sink: string[]) {
  return {
    deleteMany: ({ where }: { where: unknown }) => {
      sink.push('task');
      const kept = db.tasks.filter((task) => !matches(task, where));
      const count = db.tasks.length - kept.length;
      db.tasks = kept;
      return Promise.resolve({ count });
    }
  };
}

/**
 * 一张普通的行集合：只支持 findMany / deleteMany，够派生清理用。
 *
 * 这张替身**不做外键级联**——真库上 `ReflectionCitation.memoryId` 是 `onDelete: Cascade`，
 * 删记忆会把引用行一起带走。所以这里每一条断言走的都是「代码显式删」那条路：
 * 显式删在真库上是冗余但无害的第二道，而只有显式删才测得到（门槛 2 要的是行为，不是靠库层兜住）。
 */
function tableClient(name: string, key: 'reflections' | 'citations' | 'decisions' | 'messages', sink: string[]) {
  return {
    findMany: ({ where, select }: { where?: unknown; select?: Record<string, boolean> } = {}) => {
      sink.push(`${name}_find`);
      const rows = db[key].filter((row) => matches(row, where));
      const handed = rows.map((row) =>
        select ? Object.fromEntries(Object.keys(select).map((field) => [field, row[field]])) : { ...row }
      );
      // 交回了哪几列留个物证：「只读 id、不读正文」这条断言看的是这里。
      db.returned[name] = handed as Row[];
      return Promise.resolve(handed);
    },
    deleteMany: ({ where }: { where?: unknown } = {}) => {
      sink.push(`${name}_delete`);
      const kept = db[key].filter((row) => !matches(row, where));
      const count = db[key].length - kept.length;
      db[key] = kept;
      return Promise.resolve({ count });
    }
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (run: (tx: unknown) => Promise<unknown>) =>
      run({
        memoryItem: {
          findFirst: ({ where }: { where: unknown }) => {
            db.txOps.push('find');
            const row = matching(where)[0];
            return Promise.resolve(row ? { ...row } : null);
          },
          findMany: ({ where }: { where: unknown }) => {
            db.txOps.push('find');
            return Promise.resolve(matching(where).map((row) => ({ ...row })));
          },
          deleteMany: ({ where }: { where: unknown }) => Promise.resolve(deleteMany(where, db.txOps))
        },
        memoryRevision: {
          // 删一条要顺着「它是改口来的」那条边往回走，所以演化边先是读得见的。
          findFirst: ({ where }: { where: unknown }) => {
            db.txOps.push('edge_find');
            const row = db.edges.filter((edge) => matches(edge, where))[0];
            return Promise.resolve(row ? { ...row } : null);
          },
          updateMany: ({ where, data }: { where: unknown; data: Row }) =>
            Promise.resolve(detach(where, data, db.txOps))
        },
        memoryExclusion: exclusionClient(db.txOps),
        memoryPolicySignal: signalClient(db.txOps),
        cognitiveTask: taskClient(db.txOps),
        reflectionRecord: tableClient('reflection', 'reflections', db.txOps),
        reflectionCitation: tableClient('citation', 'citations', db.txOps),
        decisionRecord: tableClient('decision', 'decisions', db.txOps),
        message: tableClient('message', 'messages', db.txOps)
      }).then((result) => {
        db.commits += 1;
        return result;
      }),
    memoryItem: {
      deleteMany: ({ where }: { where: unknown }) => Promise.resolve(deleteMany(where, db.topOps))
    },
    memoryRevision: {
      updateMany: ({ where, data }: { where: unknown; data: Row }) =>
        Promise.resolve(detach(where, data, db.topOps))
    },
    memoryExclusion: exclusionClient(db.topOps),
    memoryPolicySignal: signalClient(db.topOps),
    cognitiveTask: taskClient(db.topOps),
    // 派生清理同样只许走事务客户端：这三张表出现在 topOps 里就等于「删了记忆、洞察留在原地」。
    reflectionRecord: tableClient('reflection', 'reflections', db.topOps),
    reflectionCitation: tableClient('citation', 'citations', db.topOps),
    decisionRecord: tableClient('decision', 'decisions', db.topOps),
    message: tableClient('message', 'messages', db.topOps),
    // 闸门在事务之外读一次偏好：null 走 getCognitivePreferences 的「没行＝全关」，
    // 抛错用来测「偏好读不出来」时学习层宁可什么都不学。
    cognitivePreference: {
      findUnique: () =>
        db.adaptiveEnabled === null
          ? Promise.reject(new Error('preference unavailable'))
          : Promise.resolve({ adaptiveMemoryEnabled: db.adaptiveEnabled })
    }
  }
}));

const USER = 'user-a';
const OTHER = 'user-b';

async function forgetting() {
  return await import('@/lib/cognitive/forgetting');
}

/** 正文用真加密：删除要读回明文才能建排除，mock 一个假密文就测不到这条路径。 */
const contentAad = (userId: string, id: string) => `memory:v1:${userId}:${id}`;

function row(id: string, overrides: Row = {}, content = '我在用 Prisma'): Row {
  const userId = String(overrides.userId ?? USER);
  return {
    id,
    userId,
    chatId: 'chat-1',
    sourceMessageId: null,
    type: 'FACT',
    context: 'GENERAL',
    origin: 'EXPLICIT',
    contentCiphertext: encryptString(content, contentAad(userId, id)),
    confirmedAt: null,
    version: 1,
    supersededAt: null,
    validFrom: null,
    validTo: null,
    validPrecision: 'UNKNOWN',
    recordedAt: new Date('2026-11-01T10:00:00.000Z'),
    ...overrides
  };
}

function edge(id: string, memoryId: string, previousId: string | null, userId = USER): Row {
  return { id, userId, action: 'SUPERSEDED', memoryId, previousId, reasonCiphertext: 'enc:v1:x', createdAt: new Date() };
}

beforeEach(() => {
  db.rows.clear();
  db.edges = [];
  db.exclusions = [];
  db.signals = [];
  db.tasks = [];
  db.reflections = [];
  db.citations = [];
  db.decisions = [];
  db.messages = [];
  db.returned = {};
  db.txOps = [];
  db.topOps = [];
  db.commits = 0;
  db.adaptiveEnabled = true;
});

/** 队列里还欠着的一条活：只带 id，所以撤它的理由永远是「归属」，不是内容。 */
function task(id: string, overrides: Row = {}): Row {
  return { id, userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY', status: 'PENDING', ...overrides };
}

describe('删除要连带撤掉还没跑的欠账', () => {
  it('删一条记忆 ⇒ 它来源那次对话的欠账一起撤，且在同一个事务里', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.tasks = [task('task-1'), task('task-2', { chatId: 'chat-2', sourceMessageId: 'msg-2' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.txOps).toContain('task');
    expect(db.topOps).toEqual([]);
    expect(db.tasks.map((row) => row.id)).toEqual(['task-2']);
  });

  it('别人那次对话的欠账一条都不动（同 chatId 也不行，得连 userId 一起对）', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.tasks = [task('task-other', { userId: OTHER })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.tasks.map((row) => row.id)).toEqual(['task-other']);
  });

  it('记忆不是从对话里来的（chatId 为空）⇒ 什么都不撤：不带 chatId 是按用户全撤', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: null }));
    db.tasks = [task('task-1'), task('task-2', { chatId: 'chat-2', sourceMessageId: 'msg-2' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.tasks).toHaveLength(2);
  });

  it('按会话删 ⇒ 撤这个会话的欠账，别的会话留着', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.tasks = [
      task('task-1'),
      task('task-2', { chatId: 'chat-2', sourceMessageId: 'msg-2' }),
      task('task-3', { chatId: 'chat-2', userId: OTHER, sourceMessageId: 'msg-3' })
    ];
    const { purgeMemoriesByChat } = await forgetting();

    await expect(purgeMemoriesByChat('chat-1', USER)).resolves.toMatchObject({ purged: 1 });

    expect(db.txOps).toContain('task');
    expect(db.tasks.map((row) => row.id)).toEqual(['task-2', 'task-3']);
  });

  it('那次对话还没产出记忆（欠账还压在队列里）⇒ 撤账不能因为「没东西可删」就跳过', async () => {
    db.tasks = [task('task-1')];
    const { purgeMemoriesByChat } = await forgetting();

    await expect(purgeMemoriesByChat('chat-1', USER)).resolves.toMatchObject({ purged: 0 });

    // 用户说的是「忘记这次对话」，跑完再补记等于把这句话又塞回来。
    expect(db.tasks).toEqual([]);
  });

  it('清空全部 ⇒ 按用户撤干净，别人的欠账一行不动，而且这条也走事务', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2', { chatId: 'chat-2' }));
    db.tasks = [task('task-1'), task('task-2', { chatId: 'chat-2' }), task('task-3', { userId: OTHER })];
    const { purgeAllMemories } = await forgetting();

    await expect(purgeAllMemories(USER)).resolves.toMatchObject({ purged: 2 });

    expect(db.commits).toBe(1);
    // 撤账走了事务客户端，就不能在事务外的连接上留下任何一次写入。
    expect(db.topOps).toEqual([]);
    expect(db.tasks.map((row) => row.id)).toEqual(['task-3']);
  });
});

describe('永久删除一条', () => {
  it('行被删掉，返回删除条数', async () => {
    db.rows.set('mem-1', row('mem-1'));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 1 });

    expect(db.rows.size).toBe(0);
  });

  it('指向它的演化边被摘开，活着的新版本保住「这是改口来的」这个事实', async () => {
    db.rows.set('mem-1', row('mem-1', { supersededAt: new Date() }));
    db.rows.set('mem-2', row('mem-2', { version: 2 }));
    db.edges = [edge('edge-1', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ id: 'edge-1', memoryId: 'mem-2', previousId: null });
  });

  it('它自己作为新版本产生的边随外键一起消失，它折叠的旧版本也不再留着', async () => {
    db.rows.set('mem-1', row('mem-1', { version: 2 }));
    db.rows.set('mem-0', row('mem-0', { supersededAt: new Date() }));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.edges).toEqual([]);
    // 留着它，时间线就会把这条刚被删掉的内容的旧说法当成一个新事件摆回来（见「整条版本链」那一组）。
    expect(db.rows.has('mem-0')).toBe(false);
  });

  it('别人的 id 删不动，返回 0，一行都没少', async () => {
    db.rows.set('mem-1', row('mem-1', { userId: OTHER }));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 0 });

    expect(db.rows.size).toBe(1);
  });

  it('不存在的 id 返回 0，不报错', async () => {
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('nope', USER)).resolves.toMatchObject({ purged: 0 });
  });

  it('摘边、删行和建排除在同一个事务里，不走事务外的连接', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.edges = [edge('edge-1', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.commits).toBe(1);
    expect(db.txOps).toContain('detach');
    expect(db.txOps).toContain('delete');
    expect(db.txOps).toContain('exclude');
    expect(db.topOps).toEqual([]);
  });
});

/**
 * 「删除事件及其派生记录」（任务书 4.4）里的那个「事件」= 一整条版本链，不是当前那一行。
 *
 * 只删当前版本会出事：被折叠在它下面的旧版本带着 supersededAt 留在库里，而它那条
 * 「我是谁的新版本」的边随外键一起消失，于是时间线读回来时它折叠不到任何后继——
 * `timeline.ts:96-101` 的做法是把这种孤行单独成事件（既有 `cognitive-timeline.test.ts:169-175` 守着）。
 * 连起来就是：用户删掉一条两版的历史，时间线下一刷新把它的第一版当成新事件摆回来，
 * 而那些正文在「记忆」那一屏根本看不见（列表只给当前有效行），用户既看不到也删不掉。
 */
describe('删除一条事件＝连它的旧版本一起删', () => {
  it('三版的链全消失，返回删掉的行数', async () => {
    db.rows.set('mem-0', row('mem-0', { supersededAt: new Date('2026-10-31T10:00:00.000Z') }, '我在用 Prisma'));
    db.rows.set('mem-1', row('mem-1', { version: 2, supersededAt: new Date('2026-11-01T10:00:00.000Z') }, '我在用 Drizzle'));
    db.rows.set('mem-2', row('mem-2', { version: 3 }, '我在用 Kysely'));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0'), edge('edge-2', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-2', USER)).resolves.toMatchObject({ purged: 3 });

    expect(db.rows.size).toBe(0);
    expect(db.edges).toEqual([]);
  });

  it('每一版的正文各记一条排除：删掉的那句和它以前的说法都不许被记回来', async () => {
    db.rows.set('mem-0', row('mem-0', { supersededAt: new Date() }, '我在用 Prisma'));
    db.rows.set('mem-1', row('mem-1', { version: 2 }, '我在用 Drizzle'));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.exclusions).toHaveLength(2);
    const hashes = db.exclusions.map((item) => item.contentHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('删中间那一版：它的历史跟着走，比它新的那一版留着', async () => {
    db.rows.set('mem-0', row('mem-0', { supersededAt: new Date('2026-10-31T10:00:00.000Z') }));
    db.rows.set('mem-1', row('mem-1', { version: 2, supersededAt: new Date('2026-11-01T10:00:00.000Z') }));
    db.rows.set('mem-2', row('mem-2', { version: 3 }));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0'), edge('edge-2', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 2 });

    expect([...db.rows.keys()]).toEqual(['mem-2']);
    // 活着那一版「来自一次改口」这个事实保住，只是不再指向一条已被删掉的正文。
    expect(db.edges).toEqual([expect.objectContaining({ id: 'edge-2', memoryId: 'mem-2', previousId: null })]);
  });

  it('一条没有前身的记忆照旧只删自己', async () => {
    db.rows.set('mem-1', row('mem-1'));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 1 });

    expect(db.rows.size).toBe(0);
  });

  it('别人的边不给我的链引路：同 memoryId 的一条别人边指到哪一行都不跟着删', async () => {
    db.rows.set('mem-1', row('mem-1', { version: 2 }));
    db.rows.set('mem-9', row('mem-9', { userId: OTHER }));
    db.edges = [edge('edge-other', 'mem-1', 'mem-9', OTHER)];
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 1 });

    expect(db.rows.has('mem-9')).toBe(true);
  });

  it('数据异常成环（互指前后）也终止，不把删除拖成死循环', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2'));
    db.edges = [edge('edge-1', 'mem-1', 'mem-2'), edge('edge-2', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 2 });

    expect(db.rows.size).toBe(0);
  });

  it('链式删除按情境记证据，不按行数：三个版本同一情境只算一条', async () => {
    db.rows.set('mem-0', row('mem-0', { context: 'TECHNICAL_PROJECT', supersededAt: new Date() }));
    db.rows.set('mem-1', row('mem-1', { context: 'TECHNICAL_PROJECT', version: 2, supersededAt: new Date() }));
    db.rows.set('mem-2', row('mem-2', { context: 'GENERAL', version: 3 }));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0'), edge('edge-2', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    const result = await purgeMemory('mem-2', USER);

    expect(result.contexts.sort()).toEqual(['general', 'technicalProject']);
    expect(db.signals).toHaveLength(2);
  });

  it('走链也整个在同一个事务里：读边不许跑到事务外的连接上', async () => {
    db.rows.set('mem-0', row('mem-0', { supersededAt: new Date() }));
    db.rows.set('mem-1', row('mem-1', { version: 2 }));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.commits).toBe(1);
    expect(db.txOps).toContain('edge_find');
    expect(db.topOps).toEqual([]);
  });
});

/**
 * 删掉的内容要进排除表（任务书 7.3「建立来源排除规则，防止后台再次提取相同信息」）。
 * 没有这一步，用户永久删除一条记忆之后，下次在对话里说同一句话它又被记回来了。
 */
describe('删除时建立来源排除', () => {
  it('删一条就记一条排除，存的是哈希和密文，不是明文', async () => {
    db.rows.set('mem-1', row('mem-1', {}, '我住在杭州'));
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.exclusions).toHaveLength(1);
    const [exclusion] = db.exclusions;
    expect(exclusion?.userId).toBe(USER);
    expect(exclusion?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(String(exclusion?.contentCiphertext)).not.toContain('我住在杭州');
    expect(exclusion).toMatchObject({ chatId: 'chat-1' });
  });

  it('按来源会话删除时，每一条都各记一条排除', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1' }, '我住在杭州'));
    db.rows.set('mem-2', row('mem-2', { chatId: 'chat-1' }, '我在用 Prisma'));
    db.rows.set('mem-3', row('mem-3', { chatId: 'chat-2' }, '别的事'));
    const { purgeMemoriesByChat } = await forgetting();

    await purgeMemoriesByChat('chat-1', USER);

    expect(db.exclusions).toHaveLength(2);
  });

  it('清空全部不建排除：那是重新开始，不是「这些话永远别再记」', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2'));
    const { purgeAllMemories } = await forgetting();

    await expect(purgeAllMemories(USER)).resolves.toMatchObject({ purged: 2 });

    expect(db.exclusions).toEqual([]);
  });

  it('删别人的记忆不建排除', async () => {
    db.rows.set('mem-1', row('mem-1', { userId: OTHER }));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 0 });

    expect(db.exclusions).toEqual([]);
  });

  it('正文解不开时照样删掉，只是不建排除——坏数据不能挡住用户的删除', async () => {
    db.rows.set('mem-1', row('mem-1', { contentCiphertext: 'enc:v1:garbage' }));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 1 });

    expect(db.rows.size).toBe(0);
    expect(db.exclusions).toEqual([]);
  });
});

describe('按来源会话删除', () => {
  beforeEach(() => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1' }));
    db.rows.set('mem-2', row('mem-2', { chatId: 'chat-1' }));
    db.rows.set('mem-3', row('mem-3', { chatId: 'chat-2' }));
    db.rows.set('mem-4', row('mem-4', { chatId: null }));
    db.rows.set('mem-5', row('mem-5', { chatId: 'chat-1', userId: OTHER }));
  });

  it('只删这个会话产生的，别的会话、没有来源的和别人的都留着', async () => {
    const { purgeMemoriesByChat } = await forgetting();

    await expect(purgeMemoriesByChat('chat-1', USER)).resolves.toMatchObject({ purged: 2 });

    expect([...db.rows.keys()].sort()).toEqual(['mem-3', 'mem-4', 'mem-5']);
  });

  it('跨会话的版本链也要摘干净：另一个会话里的新版本保住边、丢掉指针', async () => {
    db.edges = [edge('edge-1', 'mem-3', 'mem-1')];
    const { purgeMemoriesByChat } = await forgetting();

    await purgeMemoriesByChat('chat-1', USER);

    expect(db.edges).toEqual([{ ...db.edges[0], previousId: null }]);
  });

  it('这个会话一条记忆都没有时返回 0', async () => {
    const { purgeMemoriesByChat } = await forgetting();

    await expect(purgeMemoriesByChat('chat-9', USER)).resolves.toMatchObject({ purged: 0 });
  });

  it('删的是别人的会话时一行都不动', async () => {
    const { purgeMemoriesByChat } = await forgetting();

    await expect(purgeMemoriesByChat('chat-1', OTHER)).resolves.toMatchObject({ purged: 1 });

    expect(db.rows.has('mem-1')).toBe(true);
    expect(db.rows.has('mem-2')).toBe(true);
  });
});

describe('清空全部', () => {
  it('只清自己的，别人的记忆和演化边一行不动', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2', { userId: OTHER }));
    db.edges = [edge('edge-1', 'mem-1', null), edge('edge-2', 'mem-2', null, OTHER)];
    const { purgeAllMemories } = await forgetting();

    await expect(purgeAllMemories(USER)).resolves.toMatchObject({ purged: 1 });

    expect([...db.rows.keys()]).toEqual(['mem-2']);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ id: 'edge-2', userId: OTHER });
  });

  it('一条都没有时返回 0，不报错', async () => {
    const { purgeAllMemories } = await forgetting();

    await expect(purgeAllMemories(USER)).resolves.toMatchObject({ purged: 0 });
  });
});

/**
 * 学习证据（任务书 1.3）。只有永久删除算证据，而且一次操作只算一次——
 * 按会话删掉 5 条技术项目记忆是一次点击，不是五次表达，
 * 按行记证据的话一次批量清理就能把阈值刷满，那不再是「反复表达同一个意思」。
 */
describe('删除时记录策略学习证据', () => {
  it('删一条记一条，情境取自被删的那一行，返回值里带上它', async () => {
    db.rows.set('mem-1', row('mem-1', { context: 'TECHNICAL_PROJECT' }));
    const { purgeMemory } = await forgetting();

    const result = await purgeMemory('mem-1', USER);

    expect(result.contexts).toEqual(['technicalProject']);
    expect(db.signals).toHaveLength(1);
    expect(db.signals[0]).toMatchObject({ userId: USER, context: 'TECHNICAL_PROJECT' });
  });

  it('证据里只有情境和时间，没有正文也没有被删记忆的 id', async () => {
    db.rows.set('mem-1', row('mem-1', {}, '我住在杭州'));
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(Object.keys(db.signals[0]!).sort()).toEqual(['context', 'createdAt', 'id', 'userId']);
  });

  it('按会话删除时每个受影响的情境各记一条，同情境的多条只算一次', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1', context: 'TECHNICAL_PROJECT' }));
    db.rows.set('mem-2', row('mem-2', { chatId: 'chat-1', context: 'TECHNICAL_PROJECT' }));
    db.rows.set('mem-3', row('mem-3', { chatId: 'chat-1', context: 'GENERAL' }));
    const { purgeMemoriesByChat } = await forgetting();

    const result = await purgeMemoriesByChat('chat-1', USER);

    expect(result).toMatchObject({ purged: 3 });
    expect([...result.contexts].sort()).toEqual(['general', 'technicalProject']);
    expect(db.signals).toHaveLength(2);
  });

  it('清空全部不记证据：一次重置不该被读成「七个情境都记太多了」', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2', { context: 'LEARNING' }));
    const { purgeAllMemories } = await forgetting();

    const result = await purgeAllMemories(USER);

    expect(result).toMatchObject({ purged: 2 });
    expect(result.contexts).toEqual([]);
    expect(db.signals).toEqual([]);
  });

  it('删别人的记忆不记证据', async () => {
    db.rows.set('mem-1', row('mem-1', { userId: OTHER }));
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.signals).toEqual([]);
  });

  it('开关关了就不学：删一条不攒证据，但删除本身的派生清理一条都不少', async () => {
    db.adaptiveEnabled = false;
    db.rows.set('mem-1', row('mem-1', { context: 'TECHNICAL_PROJECT' }));
    db.rows.set('mem-2', row('mem-2', { version: 2 }));
    db.edges = [edge('edge-1', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    const result = await purgeMemory('mem-1', USER);

    expect(result).toMatchObject({ purged: 1, contexts: ['technicalProject'] });
    // 学习层一条证据都不攒：下次打开开关也不会被这次删除追溯性收紧
    expect(db.signals).toEqual([]);
    expect(db.txOps).not.toContain('signal');
    // 排除规则和摘边属于删除本身（任务书 7.4 门槛 2），和「学不学」是两件事，照常执行
    expect(db.txOps).toContain('exclude');
    expect(db.exclusions).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ previousId: null });
  });

  it('开关关了就不学：按会话批量删除同样一条证据都不记', async () => {
    db.adaptiveEnabled = false;
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1', context: 'TECHNICAL_PROJECT' }));
    db.rows.set('mem-2', row('mem-2', { chatId: 'chat-1', context: 'GENERAL' }));
    const { purgeMemoriesByChat } = await forgetting();

    const result = await purgeMemoriesByChat('chat-1', USER);

    expect(result).toMatchObject({ purged: 2 });
    expect([...result.contexts].sort()).toEqual(['general', 'technicalProject']);
    expect(db.signals).toEqual([]);
  });

  it('偏好读不出来当关：宁可什么都不学，也不替用户攒他没表达过的证据', async () => {
    db.adaptiveEnabled = null;
    db.rows.set('mem-1', row('mem-1'));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toMatchObject({ purged: 1 });

    expect(db.signals).toEqual([]);
  });

  it('证据和删除在同一个事务里，不会出现「删了但没记上」', async () => {
    db.rows.set('mem-1', row('mem-1'));
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.txOps).toContain('signal');
    expect(db.topOps).toEqual([]);
  });
});

/**
 * 门槛 2 的派生清理（11-04 判的甲 +「1算 2一起收 3不要报」）。
 *
 * 今天真库上的行为是**最坏的那种**：`ReflectionCitation.memoryId` 是 `onDelete: Cascade`，
 * 删一条记忆只把引用行带走，洞察那一行原样活着——标题和正文还在，底下的证据一条都不剩，
 * 用户看着一条「没有依据的洞察」待在「AI 主动洞察」那一屏。甲说的是：
 * **洞察行跟着死**，连同它的全部引用行，`@@unique([userId, dedupKey])` 那个主题位一起腾出来。
 *
 * 「1算」：只作为反证（CONTRADICTS）被引用也算这条洞察的证据。反证是它成立的一部分依据，
 * 抽掉之后那条洞察的置信度、反证命中数全是假的——宁可少一条洞察，不许留一条说不清的洞察。
 * 「2一起收」：删这次对话的记忆时，这次对话产生的决策行（DecisionRecord）一起删。
 * 单条删除**不动**决策行——「忘掉这条记忆」和「忘记这次对话」是两件事（任务书 7.3）。
 * 「3不要报」：派生删除不进界面文案，也不新增返回字段，所以下面没有一条断言看返回值里的计数。
 */
describe('删除要连带清掉派生出来的洞察与决策（门槛 2，11-04 判的甲 +「一起收」）', () => {
  function reflection(id: string, overrides: Row = {}): Row {
    return {
      id,
      userId: USER,
      dedupKey: `theme-${id}`,
      status: 'PENDING',
      titleCiphertext: 'enc:v1:t',
      ...overrides
    };
  }

  function citation(id: string, reflectionId: string, overrides: Row = {}): Row {
    return {
      id,
      userId: USER,
      reflectionId,
      memoryId: null,
      decisionId: null,
      kind: 'SUPPORTS',
      ...overrides
    };
  }

  function decision(id: string, overrides: Row = {}): Row {
    return {
      id,
      userId: USER,
      sourceMessageId: 'msg-1',
      category: 'TECH_CHOICE',
      status: 'CONFIRMED',
      topicCiphertext: 'enc:v1:t',
      ...overrides
    };
  }

  /** 消息行只带 id 和 chatId：正文列在这套替身里根本不存在，代码也就拿不到它。 */
  function message(id: string, chatId: string): Row {
    return { id, chatId };
  }

  it('被引用的记忆删掉 ⇒ 那条洞察整条消失，连同它全部的引用行', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-1')];
    db.citations = [
      citation('c-1', 'r-1', { memoryId: 'mem-1' }),
      // 同一条洞察的另一条引用指向一个决策：洞察死了它也没有意义，一起删。
      citation('c-2', 'r-1', { decisionId: 'dec-1' })
    ];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.reflections).toEqual([]);
    expect(db.citations).toEqual([]);
  });

  it('只作为反证被引用也算这条洞察的证据：删掉之后洞察照样死（「1算」）', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1', kind: 'CONTRADICTS' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.reflections).toEqual([]);
    expect(db.citations).toEqual([]);
  });

  it('找洞察排在删记忆之前：等删完了再去读引用行，真库上已经被级联带走了', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.txOps.indexOf('citation_find')).toBeGreaterThanOrEqual(0);
    expect(db.txOps.indexOf('citation_find')).toBeLessThan(db.txOps.indexOf('delete'));
  });

  it('已经采纳的洞察照样删：采纳是「用户同意过」，不是「删不掉」', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-1', { status: 'ACCEPTED' })];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.reflections).toEqual([]);
  });

  it('兄弟洞察留着：只引用别的记忆的洞察和这次删除无关', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2'));
    db.reflections = [reflection('r-1'), reflection('r-2')];
    db.citations = [
      citation('c-1', 'r-1', { memoryId: 'mem-1' }),
      citation('c-2', 'r-2', { memoryId: 'mem-2' })
    ];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.reflections.map((r) => r.id)).toEqual(['r-2']);
    expect(db.citations.map((c) => c.id)).toEqual(['c-2']);
  });

  it('链上任何一版是它的证据，这条洞察就跟着死：点的是当前版，证据挂在被纠正掉的旧版上', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.rows.set('mem-2', row('mem-2', { version: 2 }));
    // mem-2 是改口后的当前版，mem-1 是被它纠正掉的旧版——删 mem-2 会把整条事件链带走。
    db.edges = [edge('edge-1', 'mem-2', 'mem-1')];
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-2', USER);

    expect(db.reflections).toEqual([]);
    expect(db.citations).toEqual([]);
  });

  it('别人的洞察一行都不动：条件里没带 userId 就等于跨用户删数据', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-other', { userId: OTHER })];
    db.citations = [citation('c-other', 'r-other', { userId: OTHER, memoryId: 'mem-1' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.reflections.map((r) => r.id)).toEqual(['r-other']);
    expect(db.citations.map((c) => c.id)).toEqual(['c-other']);
  });

  it('读引用行也带 userId：别人的引用一条都不许进这一轮的候选', async () => {
    // 上一条只看「删没删」——两次删除都带 userId，所以读侧漂了也照样绿。
    // 这一条钉的是读：跨用户的 reflectionId 一旦被读进候选，后面任何一次漏条件的写都是跨用户删。
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-other', { userId: OTHER })];
    db.citations = [citation('c-other', 'r-other', { userId: OTHER, memoryId: 'mem-1' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.returned.citation).toEqual([]);
  });

  it('单条删除不动决策行：「忘掉这条记忆」不是「忘记这次对话」（口径边界）', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.decisions = [decision('dec-1')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.decisions.map((d) => d.id)).toEqual(['dec-1']);
    expect(db.txOps).not.toContain('decision_delete');
  });

  it('没有洞察可清时也照样删得掉：派生清理不许把删除本身挡住', async () => {
    db.rows.set('mem-1', row('mem-1'));
    const { purgeMemory } = await forgetting();

    const result = await purgeMemory('mem-1', USER);

    expect(result).toMatchObject({ purged: 1 });
    expect(db.txOps).toContain('citation_find');
    expect(db.txOps).not.toContain('reflection_delete');
  });

  it('派生清理全在事务里：不能出现「记忆删了、洞察留在原地等下一次提交」', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1' })];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.topOps).toEqual([]);
    expect(db.txOps).toContain('reflection_delete');
    expect(db.txOps).toContain('citation_delete');
  });

  it('忘记这次对话 ⇒ 这次对话产生的决策行一起删，别的对话留着（「2一起收」）', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1', sourceMessageId: 'msg-1' }));
    db.messages = [message('msg-1', 'chat-1'), message('msg-2', 'chat-9')];
    db.decisions = [decision('dec-1', { sourceMessageId: 'msg-1' }), decision('dec-2', { sourceMessageId: 'msg-2' })];
    const { purgeMemoriesByChat } = await forgetting();

    await purgeMemoriesByChat('chat-1', USER);

    expect(db.decisions.map((d) => d.id)).toEqual(['dec-2']);
  });

  it('忘记这次对话 ⇒ 引用了被删决策的洞察也一起删', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1', sourceMessageId: 'msg-1' }));
    db.messages = [message('msg-1', 'chat-1')];
    db.decisions = [decision('dec-1', { sourceMessageId: 'msg-1' })];
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { decisionId: 'dec-1' })];
    const { purgeMemoriesByChat } = await forgetting();

    await purgeMemoriesByChat('chat-1', USER);

    expect(db.reflections).toEqual([]);
    expect(db.citations).toEqual([]);
    expect(db.decisions).toEqual([]);
  });

  it('忘记这次对话不碰别的情境：这一轮的洞察引用的记忆来自别的对话就留着', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1' }));
    db.messages = [message('msg-1', 'chat-1')];
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-9', decisionId: null })];
    const { purgeMemoriesByChat } = await forgetting();

    await purgeMemoriesByChat('chat-1', USER);

    expect(db.reflections.map((r) => r.id)).toEqual(['r-1']);
    expect(db.citations.map((c) => c.id)).toEqual(['c-1']);
  });

  it('别人的会话 id 塞进来 ⇒ 读得到它的消息，删不掉我的任何一行', async () => {
    // 这条不是先红逼出来的，是钉事实的守门用例：路由不校验会话归属，消息那一头的查询本来也不带 userId
    // （Message 表没有 userId 列），所以「读跨用户」是真实发生的——它必须停在读，
    // 因为写侧的每一个条件都带着 userId。断言里特意把读到的东西也写出来，不让它被当成「上游挡过了」。
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1', sourceMessageId: 'msg-1' }));
    db.messages = [message('msg-1', 'chat-1'), message('msg-2', 'chat-9')];
    db.decisions = [
      decision('dec-1', { sourceMessageId: 'msg-1' }),
      // 这一条挂在「被我读到的那条消息」上，但属于别人：决策查询一旦漏掉 userId，它就会被带走。
      decision('dec-9', { userId: OTHER, sourceMessageId: 'msg-2' })
    ];
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1' })];
    const { purgeMemoriesByChat } = await forgetting();

    const result = await purgeMemoriesByChat('chat-9', USER);

    // 读确实跨了用户：别人会话的消息 id 进了这一轮。
    expect(db.returned.message).toEqual([{ id: 'msg-2' }]);
    // 但候选决策行一条都不许进来：和「读引用行也带 userId」那条同一课——写带条件挡得住删，挡不住读。
    expect(db.returned.decision).toEqual([]);
    // 写一行都没跟着动。
    expect(result).toMatchObject({ purged: 0 });
    expect(db.rows.has('mem-1')).toBe(true);
    expect(db.reflections.map((r) => r.id)).toEqual(['r-1']);
    expect(db.citations.map((c) => c.id)).toEqual(['c-1']);
    expect(db.decisions.map((d) => d.id)).toEqual(['dec-1', 'dec-9']);
  });

  it('清空全部 ⇒ 自己的洞察、引用、决策一起清', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-1')];
    db.citations = [citation('c-1', 'r-1', { memoryId: 'mem-1' })];
    db.decisions = [decision('dec-1')];
    const { purgeAllMemories } = await forgetting();

    const result = await purgeAllMemories(USER);

    expect(result).toMatchObject({ purged: 1 });
    expect(db.reflections).toEqual([]);
    expect(db.citations).toEqual([]);
    expect(db.decisions).toEqual([]);
  });

  it('清空只清自己：别人的洞察、引用、决策一行都不动', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.reflections = [reflection('r-other', { userId: OTHER })];
    db.citations = [citation('c-other', 'r-other', { userId: OTHER, memoryId: 'mem-1' })];
    db.decisions = [decision('dec-other', { userId: OTHER })];
    const { purgeAllMemories } = await forgetting();

    await purgeAllMemories(USER);

    expect(db.reflections.map((r) => r.id)).toEqual(['r-other']);
    expect(db.citations.map((c) => c.id)).toEqual(['c-other']);
    expect(db.decisions.map((d) => d.id)).toEqual(['dec-other']);
  });

  it('这一轮记忆还没跑出来（0 行）⇒ 决策行照样收：撤账的理由对派生清理同样成立', async () => {
    db.messages = [message('msg-1', 'chat-1')];
    db.decisions = [decision('dec-1', { sourceMessageId: 'msg-1' })];
    const { purgeMemoriesByChat } = await forgetting();

    const result = await purgeMemoriesByChat('chat-1', USER);

    expect(result).toMatchObject({ purged: 0 });
    expect(db.decisions).toEqual([]);
  });

  it('读消息只读 id：正文列不许经过这条路径', async () => {
    db.rows.set('mem-1', row('mem-1', { chatId: 'chat-1' }));
    db.messages = [{ id: 'msg-1', chatId: 'chat-1', contentCiphertext: 'enc:v1:secret' }];
    const { purgeMemoriesByChat } = await forgetting();

    await purgeMemoriesByChat('chat-1', USER);

    expect(db.returned.message).toEqual([{ id: 'msg-1' }]);
  });
});
