import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeValidRange } from '@/lib/cognitive/memory-display';

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
  edges: [] as Row[],
  evidence: [] as Row[],
  creates: [] as Row[],
  reads: [] as unknown[],
  takes: [] as Array<number | undefined>,
  tick: 0,
  commits: 0,
  failOn: null as null | 'create' | 'update' | 'edge',
  // 模拟「读完之后别的事务抢先盖了戳」：库里已经 superseded，读回来的还是旧快照。
  staleRead: false,
  updates: [] as Array<{ where: unknown; data: unknown }>
}));

/**
 * 时间戳单调递增一毫秒：全等的时间排不出「最近一条」，take 和演化顺序都会测成假的。
 * 事务里的写要等回调成功才落进 rows/edges，中途失败就什么都不留——真库不会允许半截状态，mock 也不行。
 */
function stamped(data: Row): Row {
  const now = new Date(Date.now() + (db.tick += 1));
  return { recordedAt: now, updatedAt: now, ...data };
}

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

function edgeMatching(where: unknown): Row[] {
  return db.edges.filter((edge) => matches(edge, where));
}

/**
 * 事务里的写先攒着，回调成功才一次性生效——「旧行盖了戳但新行没进来」这种半截状态
 * 在真库里不可能出现，mock 也不能让它出现，否则回滚那条测试就只是测了个寂寞。
 */
function fakeTransaction(pending: Array<() => void>) {
  return {
    memoryItem: {
      create: ({ data }: { data: Row }) => {
        if (db.failOn === 'create') return Promise.reject(new Error('新行插入失败'));
        // 和事务外那个 create 一样记账：createMemory 现在走事务，
        // 断言「写了什么进去」的用例不该因为换了执行路径就看不见数据。
        db.creates.push(data);
        const row = stamped(data);
        pending.push(() => db.rows.set(String(row.id), row));
        return Promise.resolve(row);
      },
      updateMany: ({ where, data }: { where: unknown; data: Row }) => {
        if (db.failOn === 'update') return Promise.reject(new Error('旧行盖戳失败'));
        db.updates.push({ where, data });
        const rows = matching(where);
        pending.push(() => rows.forEach((row) => Object.assign(row, data)));
        return Promise.resolve({ count: rows.length });
      }
    },
    memoryRevision: {
      create: ({ data }: { data: Row }) => {
        if (db.failOn === 'edge') return Promise.reject(new Error('演化边写入失败'));
        const row = { createdAt: new Date(Date.now() + (db.tick += 1)), ...data };
        pending.push(() => db.edges.push(row));
        return Promise.resolve(row);
      }
    },
    memoryEvidence: {
      findFirst: ({ where }: { where: unknown }) =>
        Promise.resolve(db.evidence.filter((row) => matches(row, where))[0] ?? null),
      create: ({ data }: { data: Row }) => {
        const row: Row = { createdAt: new Date(Date.now() + (db.tick += 1)), ...data };
        pending.push(() => db.evidence.push(row));
        return Promise.resolve(row);
      }
    }
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (run: (tx: unknown) => Promise<unknown>) => {
      const pending: Array<() => void> = [];
      return run(fakeTransaction(pending)).then((result) => {
        for (const commit of pending) commit();
        db.commits += 1;
        return result;
      });
    },
    memoryItem: {
      create: ({ data }: { data: Row }) => {
        // recordedAt / updatedAt 由 schema 的 @default(now()) 和 @updatedAt 填，mock 按数据库的样子补齐。
        const row = stamped(data);
        db.creates.push(data);
        db.rows.set(String(data.id), row);
        return Promise.resolve(row);
      },
      findFirst: ({ where }: { where: unknown }) => {
        db.reads.push(where);
        const row = matching(where)[0];
        // staleRead：返回「别的事务抢先之前」的快照，库里那一行已经是取代过的。
        return Promise.resolve(row ? { ...row, supersededAt: db.staleRead ? null : row.supersededAt } : null);
      },
      findMany: ({ where, orderBy, take }: { where: unknown; orderBy?: unknown; take?: number }) => {
        db.reads.push(where);
        db.takes.push(take);
        return Promise.resolve(ordered(where, orderBy, take));
      }
    },
    memoryRevision: {
      findMany: ({ where, orderBy, take }: { where: unknown; orderBy?: unknown; take?: number }) => {
        db.reads.push(where);
        db.takes.push(take);
        const direction = String((orderBy as Record<string, string> | undefined)?.createdAt ?? '');
        const rows = edgeMatching(where);
        if (direction) {
          rows.sort((a, b) =>
            direction === 'desc' ? compare(b.createdAt, a.createdAt) : compare(a.createdAt, b.createdAt)
          );
        }
        return Promise.resolve(rows.slice(0, take));
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
  db.edges = [];
  db.evidence = [];
  db.creates = [];
  db.reads = [];
  db.takes = [];
  db.tick = 0;
  db.commits = 0;
  db.failOn = null;
  db.staleRead = false;
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
    const { createMemory, listMemories, getMemory, retractMemory } = await memories();
    const memory = await createMemory(baseInput());

    await listMemories(USER);
    await getMemory(memory.id, USER);
    await retractMemory(memory.id, USER, '用户要求忘掉这件事');

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
    const { createMemory, listMemories, retractMemory, getMemory } = await memories();

    const memory = await createMemory(baseInput({ origin: 'observed', confirmedAt: undefined }));
    await retractMemory(memory.id, USER, '用户要求忘掉这件事');

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

  it('存进去的时间精度原样回带，展示层才不会把它说得更精确', async () => {
    const { createMemory } = await memories();

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

describe('记忆演化：更新是写新行，不是覆盖', () => {
  const REVISE = {
    userId: USER,
    content: '用户的澄境项目用 Next.js 15。',
    origin: 'explicit' as const,
    confirmedAt: new Date('2026-11-03T10:00:00.000Z'),
    precision: 'unknown' as const,
    reason: '用户说了新的版本号'
  };

  it('改一条记忆留下两条行：旧行只被盖上 supersededAt，密文一个字节都没动', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput({ content: '用户的澄境项目用 Next.js 14。' }));
    const sealed = { ...db.rows.get(previous.id)! };

    const next = await reviseMemory({ ...REVISE, previousId: previous.id });

    expect(next.id).not.toBe(previous.id);
    expect(next.content).toBe('用户的澄境项目用 Next.js 15。');
    expect(next.version).toBe(2);
    const kept = db.rows.get(previous.id)!;
    expect(kept.contentCiphertext).toBe(sealed.contentCiphertext);
    expect(kept.supersededAt).toBeInstanceOf(Date);
  });

  it('旧行从当前有效里消失，但按 id 仍然读得回来——历史没被删', async () => {
    const { createMemory, listMemories, getMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput({ content: '用户的澄境项目用 Next.js 14。' }));
    await reviseMemory({ ...REVISE, previousId: previous.id });

    const current = await listMemories(USER);
    const archived = await getMemory(previous.id, USER);

    expect(current.map((memory) => memory.content)).toEqual(['用户的澄境项目用 Next.js 15。']);
    expect(archived?.content).toBe('用户的澄境项目用 Next.js 14。');
    expect(archived?.supersededAt).not.toBeNull();
  });

  it('演化边记下谁取代谁、改因，以及触发它的那句话', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());

    const next = await reviseMemory({ ...REVISE, previousId: previous.id, sourceMessageId: 'msg-9', chatId: 'chat-1' });

    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({
      userId: USER,
      action: 'SUPERSEDED',
      memoryId: next.id,
      previousId: previous.id,
      sourceMessageId: 'msg-9'
    });
    // 理由里常会复述用户那句话，所以它和正文一样只能以密文躺在库里。
    expect(JSON.stringify(db.edges[0])).not.toContain('用户说了新的版本号');
  });

  it('类型和情境不传就沿用旧行，传了才换', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput({ type: 'project', context: 'technicalProject' }));

    const kept = await reviseMemory({ ...REVISE, previousId: previous.id });
    const moved = await reviseMemory({ ...REVISE, previousId: kept.id, type: 'decision', context: 'decisionMaking' });

    expect([kept.type, kept.context]).toEqual(['project', 'technicalProject']);
    expect([moved.type, moved.context]).toEqual(['decision', 'decisionMaking']);
  });

  it('事务里任何一步失败都不留下半截演化：旧行没被盖戳，也不多出当前版本', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());
    // createMemory 自己也走事务（记忆行和第一条证据要么都在要么都不在），
    // 这里数的是「演化那几次」提交了几回，所以把计数清零再开始。
    db.commits = 0;

    for (const point of ['create', 'update', 'edge'] as const) {
      db.failOn = point;
      await expect(reviseMemory({ ...REVISE, previousId: previous.id })).rejects.toThrow();
      db.failOn = null;

      expect(db.commits).toBe(0);
      expect(db.rows.size).toBe(1);
      expect(db.edges).toEqual([]);
      expect(db.rows.get(previous.id)!.supersededAt).toBeNull();
    }
  });

  it('撤回也留一条 retracted 边，写明理由', async () => {
    const { createMemory, retractMemory } = await memories();
    const memory = await createMemory(baseInput({ origin: 'observed', confirmedAt: undefined }));

    await retractMemory(memory.id, USER, '用户要求忘掉这件事');

    expect(db.rows.get(memory.id)!.origin).toBe('RETRACTED');
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({
      userId: USER,
      action: 'RETRACTED',
      memoryId: memory.id,
      previousId: null
    });
    expect(JSON.stringify(db.edges[0])).not.toContain('用户要求忘掉这件事');
  });

  it('理由为空就不许改：撤回和演化都得留下说得出口的原因', async () => {
    const { createMemory, retractMemory, reviseMemory } = await memories();
    const memory = await createMemory(baseInput());
    db.commits = 0;

    await expect(retractMemory(memory.id, USER, '   ')).rejects.toThrow(/理由/);
    await expect(reviseMemory({ ...REVISE, previousId: memory.id, reason: '' })).rejects.toThrow(/理由/);
    expect(db.edges).toEqual([]);
    expect(db.commits).toBe(0);
  });

  it('别人那条记忆改不动：按 userId 找不到旧行就报错，一行一边都不写', async () => {
    const { createMemory, reviseMemory } = await memories();
    const theirs = await createMemory(baseInput({ userId: 'user-b' }));
    db.commits = 0;

    await expect(reviseMemory({ ...REVISE, previousId: theirs.id })).rejects.toThrow(/记忆/);

    expect(db.commits).toBe(0);
    expect(db.edges).toEqual([]);
    expect(db.rows.get(theirs.id)!.supersededAt).toBeNull();
  });

  it('盖戳的条件里要求旧行还没被取代：两条并发演化不会都留下当前版本', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());

    await reviseMemory({ ...REVISE, previousId: previous.id });

    // updateMany 命中 0 行就抛错回滚，所以「读的时候还没被取代」这件事不是安全依据。
    expect(db.updates[db.updates.length - 1]).toMatchObject({
      where: { id: previous.id, userId: USER, supersededAt: null }
    });
  });

  it('已经被取代的行不能再改：报冲突，一行一边都不写', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());
    db.commits = 0;
    await reviseMemory({ ...REVISE, previousId: previous.id });
    db.updates = [];

    await expect(reviseMemory({ ...REVISE, previousId: previous.id, content: '第三次说法。' })).rejects.toThrow(/更新过/);

    expect(db.commits).toBe(1);
    expect(db.rows.size).toBe(2);
    expect(db.edges).toHaveLength(1);
    expect(db.updates).toEqual([]);
  });

  it('读完之后被人抢先：靠盖戳的条件回滚，而不是靠那次读', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());
    db.commits = 0;
    // 库里这一行已经取代过了，但读回来的还是抢先之前的快照——真库里就是这两步之间的窗口。
    Object.assign(db.rows.get(previous.id)!, { supersededAt: new Date() });
    db.staleRead = true;

    await expect(reviseMemory({ ...REVISE, previousId: previous.id })).rejects.toThrow(/更新过/);

    expect(db.commits).toBe(0);
    expect(db.rows.size).toBe(1);
    expect(db.edges).toEqual([]);
  });

  it('演化历史按调用者自己的 userId 取，换个用户什么都查不到', async () => {
    const { createMemory, reviseMemory, listMemoryRevisions } = await memories();
    const previous = await createMemory(baseInput());
    const next = await reviseMemory({ ...REVISE, previousId: previous.id });

    const mine = await listMemoryRevisions(next.id, USER);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: 'superseded', memoryId: next.id, previousId: previous.id });
    expect(mine[0]!.reason).toBe('用户说了新的版本号');
    expect(await listMemoryRevisions(next.id, 'user-b')).toEqual([]);
  });
});

/**
 * 1a 证据账本接线（任务书 2.2）。
 *
 * 记忆一落地就要有它的第一条支持证据：那句话本身就是凭据，
 * 否则一条刚记下来的记忆在置信度上会显得毫无根据。
 * 改口时新说法既是新版本的支持证据，也是旧版本的反对证据——
 * 这是事实，不是猜测：用户确实说了另一件事。
 */
describe('证据随记忆一起落库', () => {
  /** 用户亲手更正的形状：origin 由服务端定死为 userConfirmed，理由必填。 */
  const REVISE = {
    userId: USER,
    content: '用户的澄境项目用 Next.js 15。',
    origin: 'userConfirmed' as const,
    confirmedAt: new Date('2026-11-03T10:00:00.000Z'),
    precision: 'unknown' as const,
    reason: '用户说了新的版本号',
    sourceMessageId: 'msg-9'
  };

  it('创建记忆时留下一条支持证据，来源就是那句话所在的消息', async () => {
    const { createMemory } = await memories();

    const memory = await createMemory(baseInput({ chatId: 'chat-1', sourceMessageId: 'msg-1' }));

    expect(db.evidence).toHaveLength(1);
    expect(db.evidence[0]).toMatchObject({
      userId: USER,
      memoryId: memory.id,
      kind: 'SUPPORTS',
      origin: 'EXPLICIT',
      sourceMessageId: 'msg-1',
      sourceChatId: 'chat-1'
    });
  });

  it('证据和记忆行在同一个事务里：插入失败就一起回滚', async () => {
    db.failOn = 'create';
    const { createMemory } = await memories();

    await expect(createMemory(baseInput())).rejects.toThrow();

    expect(db.rows.size).toBe(0);
    expect(db.evidence).toEqual([]);
  });

  it('改口时新版本拿到支持证据、旧版本拿到反对证据，两条都指向同一句话', async () => {
    const { createMemory, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());
    db.evidence = [];

    const next = await reviseMemory({ ...REVISE, previousId: previous.id });

    expect(db.evidence).toHaveLength(2);
    const supports = db.evidence.find((row) => row.kind === 'SUPPORTS');
    const contradicts = db.evidence.find((row) => row.kind === 'CONTRADICTS');
    expect(supports).toMatchObject({ memoryId: next.id, origin: 'USER_CONFIRMED' });
    expect(contradicts).toMatchObject({ memoryId: previous.id, origin: 'USER_CONFIRMED' });
    expect(supports?.sourceMessageId).toBe(contradicts?.sourceMessageId);
  });

  it('撤回不记证据：撤回是「别再用了」，不等于「这是假的」', async () => {
    const { createMemory, retractMemory } = await memories();
    const memory = await createMemory(baseInput());
    db.evidence = [];

    await retractMemory(memory.id, USER, '这已经不是我的情况');

    expect(db.evidence).toEqual([]);
  });
});

/**
 * 4-T1 时间线要用的两处读侧接缝。
 *
 * 时间线本身是纯派生（tests/unit/cognitive-timeline.test.ts），但它得先拿到两样东西：
 * 被取代过的旧行，和能把旧行折回新版本的那批演化边。这两样都是**放宽**读取，
 * 所以钉的是「放宽只放宽到这一处」：默认口径一个字节都不许变。
 */
describe('时间线的读侧接缝', () => {
  const AGAIN = {
    userId: USER,
    content: '用户的澄境项目用 Next.js 15。',
    origin: 'explicit' as const,
    confirmedAt: new Date('2026-11-03T10:00:00.000Z'),
    precision: 'unknown' as const,
    reason: '用户说了新的版本号'
  };

  it('默认口径不变：被取代的旧行只在上限放行时才回来', async () => {
    const { createMemory, listMemories, reviseMemory } = await memories();
    const previous = await createMemory(baseInput({ content: '用户的澄境项目用 Next.js 14。' }));
    await reviseMemory({ ...AGAIN, previousId: previous.id });

    const current = await listMemories(USER);
    const withHistory = await listMemories(USER, { includeSuperseded: true });

    expect(current.map((memory) => memory.content)).toEqual(['用户的澄境项目用 Next.js 15。']);
    expect(withHistory.map((memory) => memory.content).sort()).toEqual(
      ['用户的澄境项目用 Next.js 14。', '用户的澄境项目用 Next.js 15。']
    );
  });

  it('上限放行也只放宽「被取代」这一条：撤回过的行照样不进时间线', async () => {
    const { createMemory, listMemories, retractMemory } = await memories();
    const kept = await createMemory(baseInput());
    const gone = await createMemory(baseInput({ content: '我以前住在广州。', origin: 'explicit' as const }));
    await retractMemory(gone.id, USER, '这不是我的情况');

    const rows = await listMemories(USER, { includeSuperseded: true });

    expect(rows.map((memory) => memory.id)).toEqual([kept.id]);
  });

  it('演化边一次取回整批：只带四列，不碰密文也不解密理由', async () => {
    const { createMemory, listRevisionEdges, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());
    await reviseMemory({ ...AGAIN, previousId: previous.id });
    // 一条解不开的边：列表这一层要是真去解密，这里就会炸出「（理由解密失败）」或者抛错。
    db.edges.push({
      id: 'edge-broken',
      userId: USER,
      action: 'SUPERSEDED',
      memoryId: 'mem-x',
      previousId: 'mem-y',
      reasonCiphertext: '这一列压根不是合法密文',
      sourceMessageId: null,
      createdAt: new Date('2026-11-03T09:00:00.000Z')
    });

    const edges = await listRevisionEdges(USER);

    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(Object.keys(edge).sort()).toEqual(['action', 'createdAt', 'memoryId', 'previousId']);
    }
    expect(edges.every((edge) => edge.action === 'superseded')).toBe(true);
    expect(JSON.stringify(edges)).not.toContain('这一列压根不是合法密文');
  });

  it('边按调用者自己的 userId 取，别人的边一条也不给', async () => {
    const { createMemory, listRevisionEdges, reviseMemory } = await memories();
    const previous = await createMemory(baseInput());
    await reviseMemory({ ...AGAIN, previousId: previous.id });

    const theirs = await listRevisionEdges('user-b');

    expect(theirs).toEqual([]);
  });
});
