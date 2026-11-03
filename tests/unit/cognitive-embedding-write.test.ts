import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 5c：后台写记忆那一趟顺手把向量算出来。
 *
 * 这一片要钉的四件事都在「串起来」这一层，不在客户端那一层（客户端已在
 * `cognitive-embedding-client.test.ts` 测过）：闸门关着时一字节都不出站；
 * 端点挂了不许把已经落定的记忆带下水；一轮写两条时各自的 id 要对上各自的向量；
 * 演化出来的新行同样要有向量，否则旧行有、新行没有，读侧只能看见那条被取代的说法。
 */
const db = vi.hoisted(() => ({
  memoryEnabled: true,
  associationEnabled: false,
  creates: [] as Array<Record<string, unknown>>,
  revises: [] as Array<Record<string, unknown>>,
  readRows: [] as Array<Record<string, unknown>>,
  embedCalls: [] as Array<{ userId: string; memoryId: string; text: string }>,
  embedThrows: false,
  attaches: [] as Array<{ userId: string; memoryId: string; stored: Record<string, unknown> }>,
  attachThrows: false,
  logs: [] as Array<{ event: string; fields: Record<string, unknown> }>
}));

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: () =>
    Promise.resolve({
      memoryEnabled: db.memoryEnabled,
      userModelEnabled: false,
      emotionEnabled: false,
      associationEnabled: db.associationEnabled,
      timelineEnabled: false,
      reflectionEnabled: false,
      decisionMemoryEnabled: false,
      adaptiveMemoryEnabled: false,
      emotionTransparency: 'implicit'
    })
}));

vi.mock('@/lib/cognitive/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/policy')>();
  return { ...actual, getMemoryPolicies: () => Promise.resolve(actual.DEFAULT_MEMORY_POLICIES) };
});

vi.mock('@/lib/cognitive/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/memories')>();
  return {
    ...actual,
    createMemory: (input: Record<string, unknown>) => {
      db.creates.push(input);
      return Promise.resolve({ id: `mem-${db.creates.length}` });
    },
    reviseMemory: (input: Record<string, unknown>) => {
      db.revises.push(input);
      return Promise.resolve({ id: `mem-r${db.revises.length}` });
    },
    // 匹配池由 db.readRows 给：演化那两条要用它，其余用例留空就只看新建分支。
    listMemories: (userId: string) =>
      Promise.resolve(db.readRows.filter((row) => row.userId === userId) as never),
    attachMemoryVector: (userId: string, memoryId: string, stored: Record<string, unknown>) => {
      if (db.attachThrows) return Promise.reject(new Error('列写不进去'));
      db.attaches.push({ userId, memoryId, stored });
      return Promise.resolve();
    }
  };
});

vi.mock('@/lib/cognitive/embedding', () => ({
  embedMemoryText: (userId: string, memoryId: string, text: string) => {
    db.embedCalls.push({ userId, memoryId, text });
    if (db.embedThrows) return Promise.reject(new Error('语义向量服务返回 HTTP 500'));
    return Promise.resolve({ ciphertext: Buffer.from([1, 2, 3, 4]), model: 'embed-v1' });
  }
}));

vi.mock('@/lib/cognitive/exclusions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/exclusions')>();
  return {
    ...actual,
    excludedHashes: () => Promise.resolve(new Set<string>())
  };
});

vi.mock('@/lib/cognitive/evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/evidence')>();
  return {
    ...actual,
    recordEvidenceOutsideTransaction: () => Promise.resolve()
  };
});

vi.mock('@/lib/logger', () => ({
  log: {
    warn: (event: string, fields: Record<string, unknown>) => {
      db.logs.push({ event, fields });
    },
    info: () => undefined,
    error: () => undefined
  }
}));

import { memoryModule } from '@/lib/cognitive/memory-module';

const TURN = { userId: 'user-a', chatId: 'chat-1', sourceMessageId: 'msg-1' };

async function write(content: string) {
  await memoryModule.write!({ ...TURN, content, occurredAt: new Date('2026-11-04T10:00:00.000Z') });
}

beforeEach(() => {
  db.memoryEnabled = true;
  db.associationEnabled = false;
  db.creates.length = 0;
  db.revises.length = 0;
  db.readRows.length = 0;
  db.embedCalls.length = 0;
  db.embedThrows = false;
  db.attaches.length = 0;
  db.attachThrows = false;
  db.logs.length = 0;
});

describe('开关决定这一趟出不出站', () => {
  it('关联开关关着：记忆照写，但一次出站都没有', async () => {
    await write('我在用 Prisma');

    expect(db.creates).toHaveLength(1);
    expect(db.embedCalls).toEqual([]);
    expect(db.attaches).toEqual([]);
  });

  it('关联开关开着：新写的那一行拿到向量，挂列时带上本人 userId', async () => {
    db.associationEnabled = true;

    await write('我在用 Prisma');

    expect(db.embedCalls).toEqual([{ userId: 'user-a', memoryId: 'mem-1', text: '我在用 Prisma' }]);
    expect(db.attaches).toHaveLength(1);
    expect(db.attaches[0]!.userId).toBe('user-a');
    expect(db.attaches[0]!.memoryId).toBe('mem-1');
    expect(db.attaches[0]!.stored.model).toBe('embed-v1');
  });

  it('记忆开关本身关着时更不会出站：这一轮一行都不写', async () => {
    db.memoryEnabled = false;
    db.associationEnabled = true;

    await write('我在用 Prisma');

    expect(db.creates).toEqual([]);
    expect(db.embedCalls).toEqual([]);
  });
});

describe('这一趟坏了不许影响已经落定的记忆', () => {
  it('端点报错：记忆那条行照在，告警只有 id 没有正文', async () => {
    db.associationEnabled = true;
    db.embedThrows = true;

    await expect(write('我在用 Prisma')).resolves.toBeUndefined();

    expect(db.creates).toHaveLength(1);
    expect(db.attaches).toEqual([]);
    expect(db.logs.map((entry) => entry.event)).toContain('cognitive.embedding_failed');
    expect(JSON.stringify(db.logs)).not.toContain('我在用 Prisma');
  });

  it('挂列报错也一样吞下：正文已经写成了，不该因为向量补不上就回滚不了', async () => {
    db.associationEnabled = true;
    db.attachThrows = true;

    await expect(write('我在用 Prisma')).resolves.toBeUndefined();

    expect(db.creates).toHaveLength(1);
    expect(db.logs.map((entry) => entry.event)).toContain('cognitive.embedding_failed');
  });
});

describe('一轮里多条记忆各算各的', () => {
  it('两条新说法挂到两个不同的 id，正文各自对上', async () => {
    db.associationEnabled = true;

    await write(['我在用 Prisma。', '我住在杭州。'].join(''));

    expect(db.creates).toHaveLength(2);
    expect(db.attaches.map((entry) => entry.memoryId)).toEqual(['mem-1', 'mem-2']);
    expect(db.embedCalls.map((call) => call.text)).toEqual(['我在用 Prisma', '我住在杭州']);
  });

  it('改口产生的新版本也要有自己的向量：旧行有、新行没有，读侧就会偏向那条已经作废的说法', async () => {
    db.associationEnabled = true;
    db.readRows = [
      {
        id: 'mem-old',
        userId: 'user-a',
        chatId: 'chat-1',
        type: 'project',
        context: 'technicalProject',
        origin: 'explicit',
        content: '我在用 Next.js 14',
        confirmedAt: '2026-11-01T10:00:00.000Z',
        precision: 'unknown',
        validFrom: null,
        validTo: null,
        version: 1,
        supersededAt: null,
        recordedAt: '2026-11-01T10:00:00.000Z'
      }
    ];

    await write('我在用 Next.js 15。');

    expect(db.revises).toHaveLength(1);
    expect(db.attaches).toHaveLength(1);
    expect(db.attaches[0]!.memoryId).toBe('mem-r1');
    expect(db.embedCalls[0]!.text).toBe('我在用 Next.js 15');
  });

  it('只是「换个对话又原话说一遍」不新增行，因此也不该多算一次向量', async () => {
    db.associationEnabled = true;
    db.readRows = [
      {
        id: 'mem-old',
        userId: 'user-a',
        // 来源是另一个对话：这句会被记成一次独立证据，而不是第二条记忆。
        chatId: 'chat-0',
        type: 'project',
        context: 'technicalProject',
        origin: 'explicit',
        content: '我在用 Prisma',
        confirmedAt: '2026-11-01T10:00:00.000Z',
        precision: 'unknown',
        validFrom: null,
        validTo: null,
        version: 1,
        supersededAt: null,
        recordedAt: '2026-11-01T10:00:00.000Z'
      }
    ];

    await write('我在用 Prisma');

    expect(db.creates).toEqual([]);
    expect(db.embedCalls).toEqual([]);
  });
});
