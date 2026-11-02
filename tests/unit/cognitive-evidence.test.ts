import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import type { ConfidenceSubject } from '@/lib/cognitive/evidence';
import type { Prisma } from '@prisma/client';

/**
 * 证据账本（任务书 2.2）。这里钉的是四件事——
 * 证据只回答「这条记忆凭什么在这里」，不改变它的内容；
 * 同一条消息对同一条记忆同一个方向只算一次（重复计分等于凭空抬高可信度）；
 * 说明文字和记忆正文同等对待，落库是密文；
 * 以及一次查询算完一批记忆的置信度，不是每条各查一次。
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  queries: [] as string[],
  tick: 0
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

function client() {
  return {
    memoryEvidence: {
      findFirst: ({ where }: { where: unknown }) => {
        db.queries.push('findFirst');
        const row = db.rows.filter((candidate) => matches(candidate, where))[0];
        return Promise.resolve(row ? { ...row } : null);
      },
      findMany: ({ where, orderBy }: { where: unknown; orderBy?: unknown }) => {
        db.queries.push('findMany');
        const rows = db.rows.filter((row) => matches(row, where));
        if (String((orderBy as Record<string, string> | undefined)?.createdAt ?? '') === 'desc') {
          rows.sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
        }
        return Promise.resolve(rows.map((row) => ({ ...row })));
      },
      groupBy: ({ by, where }: { by: string[]; where: unknown }) => {
        db.queries.push('groupBy');
        const groups = new Map<string, Row>();
        for (const row of db.rows.filter((candidate) => matches(candidate, where))) {
          const key = by.map((field) => String(row[field])).join('|');
          const entry = groups.get(key) ?? { ...row, _count: { _all: 0 } };
          (entry._count as { _all: number })._all += 1;
          groups.set(key, entry);
        }
        return Promise.resolve([...groups.values()]);
      },
      create: ({ data }: { data: Row }) => {
        db.queries.push('create');
        // 库层的 @@unique([userId, memoryId, kind, sourceMessageId])
        const clash = db.rows.filter(
          (row) =>
            row.userId === data.userId &&
            row.memoryId === data.memoryId &&
            row.kind === data.kind &&
            row.sourceMessageId === data.sourceMessageId
        );
        if (clash.length > 0) {
          return Promise.reject(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
        }
        const row: Row = { createdAt: new Date(Date.now() + (db.tick += 1)), ...data };
        db.rows.push(row);
        return Promise.resolve({ ...row });
      }
    }
  };
}

vi.mock('@/lib/prisma', () => {
  const base = client();
  return { prisma: { ...base, $transaction: (run: (tx: unknown) => Promise<unknown>) => run(client()) } };
});

const USER = 'user-a';
const OTHER = 'user-b';

async function evidence() {
  return await import('@/lib/cognitive/evidence');
}

function inTx<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(run) as Promise<T>;
}

async function record(input: Record<string, unknown>) {
  const { recordEvidence } = await evidence();
  return inTx((tx) => recordEvidence(tx, { userId: USER, memoryId: 'mem-1', ...input } as never));
}

/** 造一条记忆的形状；assessMemories 只读这五个字段。 */
function subject(id: string, overrides: Record<string, unknown> = {}): ConfidenceSubject {
  return {
    id,
    origin: 'explicit',
    confirmedAt: '2026-11-01T10:00:00.000Z',
    supersededAt: null,
    validTo: null,
    ...overrides
  } as ConfidenceSubject;
}

beforeEach(() => {
  db.rows = [];
  db.queries = [];
  db.tick = 0;
});

describe('记录证据', () => {
  it('落一行，方向和来源入库是大写枚举', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1', sourceChatId: 'chat-1' });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      userId: USER,
      memoryId: 'mem-1',
      kind: 'SUPPORTS',
      origin: 'EXPLICIT',
      sourceMessageId: 'msg-1',
      sourceChatId: 'chat-1'
    });
  });

  it('同一条消息、同一条记忆、同一方向第二次不重复记', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });

    expect(db.rows).toHaveLength(1);
  });

  it('不同方向可以各记一条：同一句话既支持新说法也反对旧说法', async () => {
    await record({ kind: 'supports', origin: 'userConfirmed', sourceMessageId: 'msg-1' });
    await record({ kind: 'contradicts', origin: 'userConfirmed', sourceMessageId: 'msg-1' });

    expect(db.rows).toHaveLength(2);
  });

  it('不同消息各记一条，这才是「独立证据」', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-2' });

    expect(db.rows).toHaveLength(2);
  });

  it('说明文字落库是密文，读回来才是明文', async () => {
    await record({ kind: 'contradicts', origin: 'userConfirmed', sourceMessageId: 'msg-1', note: '项目已经换成 PostgreSQL' });

    expect(String(db.rows[0]?.noteCiphertext)).not.toContain('PostgreSQL');
    expect(String(db.rows[0]?.noteCiphertext)).toMatch(/^enc:v1:/);

    const { listEvidence } = await evidence();
    const [entry] = await listEvidence('mem-1', USER);
    expect(entry?.note).toBe('项目已经换成 PostgreSQL');
  });

  it('没有说明文字时不写空密文', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });

    expect(db.rows[0]?.noteCiphertext).toBeNull();
  });

  it('非法的方向和来源在落库前就被拒', async () => {
    const { recordEvidence } = await evidence();

    await expect(
      inTx((tx) =>
        recordEvidence(tx, {
          userId: USER,
          memoryId: 'mem-1',
          kind: 'maybe' as never,
          origin: 'explicit',
          sourceMessageId: 'msg-1'
        })
      )
    ).rejects.toThrow();
    expect(db.rows).toEqual([]);
  });
});

describe('读取证据', () => {
  it('只返回自己的，按时间倒序', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-2' });
    const { recordEvidence } = await evidence();
    await inTx((tx) =>
      recordEvidence(tx, {
        userId: OTHER,
        memoryId: 'mem-1',
        kind: 'supports',
        origin: 'explicit',
        sourceMessageId: 'msg-3'
      })
    );

    const { listEvidence } = await evidence();
    const list = await listEvidence('mem-1', USER);

    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.sourceMessageId)).toEqual(['msg-2', 'msg-1']);
    expect(list[0]).toMatchObject({ kind: 'supports', origin: 'explicit' });
  });
});

describe('批量算置信度', () => {
  it('一次查询算完一批，不是每条记忆各查一次', async () => {
    const { assessMemories } = await evidence();
    db.queries = [];

    await assessMemories(USER, [subject('mem-1'), subject('mem-2'), subject('mem-3')]);

    expect(db.queries.filter((query) => query === 'groupBy')).toHaveLength(1);
  });

  it('没有证据的记忆按来源基线给分', async () => {
    const { assessMemories } = await evidence();

    const result = await assessMemories(USER, [subject('mem-1')]);

    expect(result.get('mem-1')).toMatchObject({ band: 'medium' });
    expect(result.get('mem-1')?.factors).toEqual([{ kind: 'origin', origin: 'explicit' }]);
  });

  it('独立证据越多分越高，档位跟着升', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });
    const { recordEvidence } = await evidence();
    for (const id of ['msg-2', 'msg-3', 'msg-4']) {
      await inTx((tx) =>
        recordEvidence(tx, { userId: USER, memoryId: 'mem-1', kind: 'supports', origin: 'explicit', sourceMessageId: id })
      );
    }
    const { assessMemories } = await evidence();

    const result = await assessMemories(USER, [subject('mem-1')]);

    expect(result.get('mem-1')?.score).toBeCloseTo(0.84, 5);
    expect(result.get('mem-1')?.band).toBe('high');
    expect(result.get('mem-1')?.factors).toContainEqual({ kind: 'restated', count: 3 });
  });

  it('有反对证据就压在低档', async () => {
    await record({ kind: 'supports', origin: 'explicit', sourceMessageId: 'msg-1' });
    await record({ kind: 'contradicts', origin: 'userConfirmed', sourceMessageId: 'msg-2' });
    const { assessMemories } = await evidence();

    const result = await assessMemories(USER, [subject('mem-1')]);

    expect(result.get('mem-1')?.band).toBe('low');
    expect(result.get('mem-1')?.factors).toContainEqual({ kind: 'contradicted', count: 1 });
  });

  it('别人的证据不会抬 high 自己的记忆', async () => {
    const { recordEvidence, assessMemories } = await evidence();
    for (const id of ['msg-1', 'msg-2', 'msg-3']) {
      await inTx((tx) =>
        recordEvidence(tx, { userId: OTHER, memoryId: 'mem-1', kind: 'supports', origin: 'explicit', sourceMessageId: id })
      );
    }

    const result = await assessMemories(USER, [subject('mem-1')]);

    expect(result.get('mem-1')?.score).toBeCloseTo(0.6, 5);
  });

  it('空列表不发查询', async () => {
    const { assessMemories } = await evidence();
    db.queries = [];

    await expect(assessMemories(USER, [])).resolves.toEqual(new Map());

    expect(db.queries).toEqual([]);
  });
});
