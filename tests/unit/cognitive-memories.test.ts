import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 2 片A：记忆主体。钉的是任务书 2.1、2.2 的三条硬要求——
 * 双时间（事实成立区间 vs 系统记录时间）分开，且模糊时间不许伪造成精确日期；
 * 推断不得冒充用户确认过的事实；正文一律 AES-256-GCM 加密，AAD 绑住 userId，
 * 别人的行即使泄漏到手里也解不开。
 *
 * 这里刻意没有 confidence 字段：任务书禁止模型随口报一个数当置信度，
 * 它必须和证据计数、冲突情况一起算，放到片C 再落。
 *
 * 下面的 prisma mock 带一个 where 求值器：时间有效性过滤交给数据库表达才有意义，
 * 所以测试要真的按条件筛行，而不是只检查条件长什么样。求值器只覆盖服务用到的算子。
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  creates: [] as Row[],
  reads: [] as unknown[],
  takes: [] as Array<number | undefined>,
  tick: 0,
  updates: [] as Array<{ where: unknown; data: unknown }>
}));

function compare(value: unknown, other: unknown): number {
  return new Date(value as string).getTime() - new Date(other as string).getTime();
}

function satisfies(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date || typeof condition !== 'object') return value === condition;

  const c = condition as Record<string, unknown>;
  if ('in' in c) return (c.in as unknown[]).includes(value);
  if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
  if ('not' in c) return !satisfies(value, c.not);
  if (value === null || value === undefined) return false;
  if ('gte' in c) return compare(value, c.gte) >= 0;
  if ('lte' in c) return compare(value, c.lte) <= 0;
  if ('gt' in c) return compare(value, c.gt) > 0;
  if ('lt' in c) return compare(value, c.lt) < 0;
  return value === condition;
}

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  for (const [field, condition] of Object.entries(where as Record<string, unknown>)) {
    if (field === 'AND') {
      if (!(condition as unknown[]).every((part) => matches(row, part))) return false;
      continue;
    }
    if (field === 'OR') {
      if (!(condition as unknown[]).some((part) => matches(row, part))) return false;
      continue;
    }
    if (!satisfies(row[field], condition)) return false;
  }
  return true;
}

function matching(where: unknown): Row[] {
  return [...db.rows.values()].filter((row) => matches(row, where));
}

/** 按 orderBy 真的排序：take 截的是「最近几条」，顺序错了截到的就是最早那批。 */
function ordered(where: unknown, orderBy: unknown, take?: number): Row[] {
  const direction = String((orderBy as Record<string, string> | undefined)?.recordedAt ?? '');
  const rows = matching(where);
  if (direction) {
    rows.sort((a, b) =>
      direction === 'desc'
        ? compare(b.recordedAt, a.recordedAt)
        : compare(a.recordedAt, b.recordedAt)
    );
  }
  return rows.slice(0, take);
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    memoryItem: {
      create: ({ data }: { data: Row }) => {
        // recordedAt / updatedAt 由 schema 的 @default(now()) 和 @updatedAt 填，mock 按数据库的样子补齐；
        // 单调递增一个毫秒，否则同一批行时间全等，「最近 8 条」这种条件测不出真假。
        const now = new Date(Date.now() + (db.tick += 1));
        const row = { recordedAt: now, updatedAt: now, ...data };
        db.creates.push(data);
        db.rows.set(String(data.id), row);
        return Promise.resolve(row);
      },
      findFirst: ({ where }: { where: unknown }) => {
        db.reads.push(where);
        return Promise.resolve(matching(where)[0] ?? null);
      },
      findMany: ({ where, orderBy, take }: { where: unknown; orderBy?: unknown; take?: number }) => {
        db.reads.push(where);
        db.takes.push(take);
        return Promise.resolve(ordered(where, orderBy, take));
      },
      updateMany: ({ where, data }: { where: unknown; data: Row }) => {
        db.updates.push({ where, data });
        const rows = matching(where);
        for (const row of rows) Object.assign(row, data);
        return Promise.resolve({ count: rows.length });
      }
    }
  }
}));

const USER = 'user-a';

async function memories() {
  return await import('@/lib/cognitive/memories');
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    type: 'fact' as const,
    context: 'technicalProject' as const,
    content: '用户的澄境项目用 Next.js 15 和 Prisma。',
    origin: 'explicit' as const,
    confirmedAt: new Date('2026-11-02T10:00:00.000Z'),
    precision: 'timestamp' as const,
    ...overrides
  };
}

beforeEach(() => {
  db.rows.clear();
  db.creates = [];
  db.reads = [];
  db.takes = [];
  db.tick = 0;
  db.updates = [];
});

describe('记忆写入的校验', () => {
  it('正文加密入库，读回来才是原文', async () => {
    const { createMemory, listMemories } = await memories();

    await createMemory(baseInput());
    const [memory] = await listMemories(USER);

    const stored = db.creates[0];
    expect(stored.contentCiphertext).not.toContain('Next.js');
    expect(String(stored.contentCiphertext).length).toBeGreaterThan(40);
    expect(memory?.content).toBe('用户的澄境项目用 Next.js 15 和 Prisma。');
  });

  it('AAD 绑住 userId：同一行密文换个用户解不开', async () => {
    const { createMemory, decryptMemoryContent } = await memories();

    await createMemory(baseInput());
    const stored = [...db.rows.values()][0] as Row;
    const row = {
      id: String(stored.id),
      userId: String(stored.userId),
      contentCiphertext: String(stored.contentCiphertext)
    };

    expect(() => decryptMemoryContent(row, 'user-b')).toThrow();
    expect(decryptMemoryContent(row, USER)).toBe('用户的澄境项目用 Next.js 15 和 Prisma。');
  });

  it('空白正文和超长正文都被拒', async () => {
    const { createMemory, MEMORY_CONTENT_MAX_CHARS } = await memories();

    await expect(createMemory(baseInput({ content: '   ' }))).rejects.toThrow(/正文/);
    await expect(
      createMemory(baseInput({ content: '长'.repeat(MEMORY_CONTENT_MAX_CHARS + 1) }))
    ).rejects.toThrow(/正文/);
    expect(db.creates).toEqual([]);
  });

  it('用户亲口说和确认过的必须有确认时间，推断和观察不许冒充确认', async () => {
    const { createMemory } = await memories();

    await expect(createMemory(baseInput({ origin: 'explicit', confirmedAt: undefined }))).rejects.toThrow(/确认/);
    await expect(
      createMemory(baseInput({ origin: 'inferred', confirmedAt: new Date('2026-11-02T10:00:00.000Z') }))
    ).rejects.toThrow(/确认/);

    const inferred = await createMemory(baseInput({ origin: 'inferred', confirmedAt: undefined }));
    expect(inferred.origin).toBe('inferred');
    expect(inferred.confirmedAt).toBeNull();
  });

  it('时间精度不够就不许写成精确日期', async () => {
    const { createMemory } = await memories();

    await expect(
      createMemory(baseInput({ precision: 'unknown', validFrom: new Date('2026-01-01T00:00:00.000Z') }))
    ).rejects.toThrow(/时间/);
    await expect(
      createMemory(baseInput({ precision: 'year', validFrom: new Date('2026-03-05T00:00:00.000Z') }))
    ).rejects.toThrow(/精度/);
    await expect(
      createMemory(baseInput({ precision: 'month', validFrom: new Date('2026-03-05T00:00:00.000Z') }))
    ).rejects.toThrow(/精度/);
    await expect(
      createMemory(baseInput({ precision: 'day', validFrom: new Date('2026-03-05T08:00:00.000Z') }))
    ).rejects.toThrow(/精度/);
  });

  it('失效时间必须晚于生效时间', async () => {
    const { createMemory } = await memories();

    await expect(
      createMemory(
        baseInput({
          precision: 'day',
          validFrom: new Date('2026-05-02T00:00:00.000Z'),
          validTo: new Date('2026-05-01T00:00:00.000Z')
        })
      )
    ).rejects.toThrow(/有效/);
  });

  it('落库的行带的是调用者自己的 userId，且默认就是当前版本', async () => {
    const { createMemory } = await memories();

    const memory = await createMemory(baseInput());

    expect(db.creates[0]).toMatchObject({ userId: USER, version: 1, supersededAt: null });
    expect(memory.version).toBe(1);
    expect(memory.id).toBe(String(db.creates[0].id));
  });
});

describe('记忆读取与时间有效性', () => {
  it('读取和更新的条件里都带上调用者自己的 userId', async () => {
    const { createMemory, listMemories, getMemory, markMemoryRetracted } = await memories();
    const memory = await createMemory(baseInput());

    await listMemories(USER);
    await getMemory(memory.id, USER);
    await markMemoryRetracted(memory.id, USER);

    expect(db.reads.length).toBeGreaterThanOrEqual(2);
    for (const where of [...db.reads, ...db.updates.map((entry) => entry.where)]) {
      expect(where).toMatchObject({ userId: USER });
    }
  });

  it('按时间点取当前有效记忆：已失效和未来才生效的都排除', async () => {
    const { createMemory, listMemories } = await memories();
    const day = (text: string) => new Date(`${text}T00:00:00.000Z`);

    await createMemory(baseInput({ precision: 'day', validFrom: day('2026-01-01') }));
    await createMemory(
      baseInput({
        content: '旧习惯已经改掉。',
        precision: 'day',
        validFrom: day('2025-01-01'),
        validTo: day('2025-12-31')
      })
    );
    await createMemory(baseInput({ content: '明年才成立的打算。', precision: 'day', validFrom: day('2027-06-01') }));

    const current = await listMemories(USER, { asOf: day('2026-06-01') });

    expect(current.map((memory) => memory.content)).toEqual(['用户的澄境项目用 Next.js 15 和 Prisma。']);
  });

  it('没有有效区间的记忆始终算当前有效', async () => {
    const { createMemory, listMemories } = await memories();

    await createMemory(baseInput({ precision: 'timestamp' }));

    const asOf2020 = await listMemories(USER, { asOf: new Date('2020-01-01T00:00:00.000Z') });
    expect(asOf2020).toHaveLength(1);
  });

  it('撤回的记忆不再出现在当前有效里，但单独读仍然读得到', async () => {
    const { createMemory, listMemories, markMemoryRetracted, getMemory } = await memories();

    const memory = await createMemory(baseInput({ origin: 'observed', confirmedAt: undefined }));
    await markMemoryRetracted(memory.id, USER);

    expect(await listMemories(USER)).toEqual([]);
    const fetched = await getMemory(memory.id, USER);
    expect(fetched?.origin).toBe('retracted');
  });

  it('换情境或换类型的过滤条件不影响隔离，别人的记忆读不到', async () => {
    const { createMemory, getMemory, listMemories } = await memories();

    const memory = await createMemory(baseInput());

    expect(await getMemory(memory.id, 'user-b')).toBeNull();
    expect(await listMemories('user-b')).toEqual([]);
    expect(await listMemories(USER, { contexts: ['emotionalSupport'] })).toEqual([]);
    expect(await listMemories(USER, { types: ['fact'] })).toHaveLength(1);
  });

  it('take 只捞要的那几行，而且捞的是最近那几条：给 8 条上限就不会把 200 条密文全搬回来解密', async () => {
    const { createMemory, listMemories } = await memories();
    for (let index = 0; index < 20; index += 1) {
      await createMemory(baseInput({ content: `第 ${index} 条记忆。` }));
    }

    const rows = await listMemories(USER, { take: 8 });

    expect(rows).toHaveLength(8);
    expect(db.takes[db.takes.length - 1]).toBe(8);
    expect(rows.map((memory) => memory.content)).toEqual([
      '第 19 条记忆。',
      '第 18 条记忆。',
      '第 17 条记忆。',
      '第 16 条记忆。',
      '第 15 条记忆。',
      '第 14 条记忆。',
      '第 13 条记忆。',
      '第 12 条记忆。'
    ]);
  });

  it('不给 take 时仍然有 200 行的硬上限', async () => {
    const { listMemories } = await memories();

    await listMemories(USER);

    expect(db.takes[0]).toBe(200);
  });

  it('take 超过上限时被压回 200：调用方不能把它当成放开闸门', async () => {
    const { listMemories } = await memories();

    await listMemories(USER, { take: 50_000 });

    expect(db.takes[0]).toBe(200);
  });

  it('有效区间按精度回显，不显示成比实际更精确的日期', async () => {
    const { createMemory, describeValidRange } = await memories();

    const year = await createMemory(
      baseInput({ precision: 'year', validFrom: new Date('2026-01-01T00:00:00.000Z') })
    );
    const month = await createMemory(
      baseInput({ precision: 'month', validFrom: new Date('2026-03-01T00:00:00.000Z') })
    );
    const day = await createMemory(
      baseInput({ precision: 'day', validFrom: new Date('2026-03-05T00:00:00.000Z') })
    );
    const unknown = await createMemory(baseInput({ precision: 'unknown' }));
    const exact = await createMemory(
      baseInput({ precision: 'timestamp', validFrom: new Date('2026-03-05T08:00:00.000Z') })
    );

    expect(describeValidRange(year)).toBe('2026年');
    expect(describeValidRange(month)).toBe('2026年3月');
    expect(describeValidRange(day)).toBe('2026年3月5日');
    expect(describeValidRange(exact)).toBe('2026年3月5日 08:00');
    expect(describeValidRange(unknown)).toBe('时间未知');
  });
});
