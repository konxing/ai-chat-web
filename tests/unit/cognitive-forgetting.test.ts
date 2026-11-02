import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 永久删除（任务书 7.2 的 DELETE、7.3 的用户遗忘功能、7.4 门槛 2「派生数据按策略清理」）。
 *
 * 这里最难的一条不是删行，是删行之前先处理演化边：MemoryRevision.previousId 的外键是
 * ON DELETE CASCADE，直接删旧版本会把「新版本是改口来的」那条边一起带走，
 * 活着的那一行版本链就凭空断了。所以先把指向被删行的边摘开（previousId 置 null，
 * 该列本身可空），保住「这一版来自一次改口」这个事实，同时不留指向已删内容的指针。
 *
 * 派生数据当前只有演化边一种：Embedding、图关系、时间线、反思、决策、认知任务都还没落地，
 * 等它们出现时这里要跟着加清理，测试也要跟着加断言。
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  edges: [] as Row[],
  txOps: [] as string[],
  topOps: [] as string[],
  commits: 0
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

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (run: (tx: unknown) => Promise<unknown>) =>
      run({
        memoryItem: {
          findMany: ({ where }: { where: unknown }) => Promise.resolve(matching(where).map((row) => ({ ...row }))),
          deleteMany: ({ where }: { where: unknown }) => Promise.resolve(deleteMany(where, db.txOps))
        },
        memoryRevision: {
          updateMany: ({ where, data }: { where: unknown; data: Row }) =>
            Promise.resolve(detach(where, data, db.txOps))
        }
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
    }
  }
}));

const USER = 'user-a';
const OTHER = 'user-b';

async function forgetting() {
  return await import('@/lib/cognitive/forgetting');
}

function row(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: USER,
    chatId: 'chat-1',
    sourceMessageId: null,
    type: 'FACT',
    context: 'GENERAL',
    origin: 'EXPLICIT',
    contentCiphertext: 'enc:v1:not-used-here',
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
  db.txOps = [];
  db.topOps = [];
  db.commits = 0;
});

describe('永久删除一条', () => {
  it('行被删掉，返回删除条数', async () => {
    db.rows.set('mem-1', row('mem-1'));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toBe(1);

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

  it('它自己作为新版本产生的边随外键一起消失', async () => {
    db.rows.set('mem-1', row('mem-1', { version: 2 }));
    db.rows.set('mem-0', row('mem-0', { supersededAt: new Date() }));
    db.edges = [edge('edge-1', 'mem-1', 'mem-0')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.edges).toEqual([]);
    expect(db.rows.has('mem-0')).toBe(true);
  });

  it('别人的 id 删不动，返回 0，一行都没少', async () => {
    db.rows.set('mem-1', row('mem-1', { userId: OTHER }));
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('mem-1', USER)).resolves.toBe(0);

    expect(db.rows.size).toBe(1);
  });

  it('不存在的 id 返回 0，不报错', async () => {
    const { purgeMemory } = await forgetting();

    await expect(purgeMemory('nope', USER)).resolves.toBe(0);
  });

  it('摘边和删行在同一个事务里，不走事务外的连接', async () => {
    db.rows.set('mem-1', row('mem-1'));
    db.edges = [edge('edge-1', 'mem-2', 'mem-1')];
    const { purgeMemory } = await forgetting();

    await purgeMemory('mem-1', USER);

    expect(db.commits).toBe(1);
    expect(db.txOps).toEqual(['detach', 'delete']);
    expect(db.topOps).toEqual([]);
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

    await expect(purgeMemoriesByChat('chat-1', USER)).resolves.toBe(2);

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

    await expect(purgeMemoriesByChat('chat-9', USER)).resolves.toBe(0);
  });

  it('删的是别人的会话时一行都不动', async () => {
    const { purgeMemoriesByChat } = await forgetting();

    await expect(purgeMemoriesByChat('chat-1', OTHER)).resolves.toBe(1);

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

    await expect(purgeAllMemories(USER)).resolves.toBe(1);

    expect([...db.rows.keys()]).toEqual(['mem-2']);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ id: 'edge-2', userId: OTHER });
  });

  it('一条都没有时返回 0，不报错', async () => {
    const { purgeAllMemories } = await forgetting();

    await expect(purgeAllMemories(USER)).resolves.toBe(0);
  });
});
