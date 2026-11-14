import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

/**
 * 来源排除规则（任务书 7.3：「需要建立来源排除规则，防止后台再次提取相同信息」）。
 *
 * 落点是写侧：本项目没有后台重扫历史消息的任务，同一句话会被重新记住的真实路径是
 * 用户后来又说了一遍。所以排除按「归一化后的正文」匹配，而不是按 sourceMessageId——
 * 换一句话重说，消息 id 就变了，按 id 排除等于什么都没排除。
 *
 * 哈希用 HMAC(APP_SECRET, userId:归一化正文)：既能 O(1) 匹配，又不是明文的等价物
 * （拿不到 APP_SECRET 就没法用字典反查）。另存一份密文只为界面能显示和撤销——
 * 只存哈希的话，用户面对一排指纹认不出哪条是哪条，也就没法行使撤销权。
 *
 * 上限 500 条并按 createdAt 淘汰最旧的：排除表是隐私控件，但不能变成无限增长的表。
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
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

function matching(where: unknown): Row[] {
  return [...db.rows.values()].filter((row) => matches(row, where));
}

function ordered(where: unknown, orderBy: unknown): Row[] {
  const direction = String((orderBy as Record<string, string> | undefined)?.createdAt ?? '');
  const rows = matching(where);
  if (direction) {
    rows.sort((a, b) => {
      const left = (a.createdAt as Date).getTime();
      const right = (b.createdAt as Date).getTime();
      return direction === 'desc' ? right - left : left - right;
    });
  }
  return rows;
}

/** 时间戳单调递增一毫秒：淘汰「最旧的」要能排出先后，全等的时间测不出淘汰了谁。 */
function client() {
  return {
    memoryExclusion: {
      findMany: ({ where, orderBy, take }: { where: unknown; orderBy?: unknown; take?: number }) =>
        Promise.resolve(ordered(where, orderBy).slice(0, take).map((row) => ({ ...row }))),
      create: ({ data }: { data: Row }) => {
        const row: Row = { createdAt: new Date(Date.now() + (db.tick += 1)), ...data };
        // 复合唯一约束 @@unique([userId, contentHash])：真库会抛 P2002，mock 也照做。
        if (matching({ userId: row.userId, contentHash: row.contentHash }).length > 0) {
          return Promise.reject(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
        }
        db.rows.set(String(row.id), row);
        return Promise.resolve({ ...row });
      },
      count: ({ where }: { where: unknown }) => Promise.resolve(matching(where).length),
      deleteMany: ({ where }: { where: unknown }) => {
        const rows = matching(where);
        for (const row of rows) db.rows.delete(String(row.id));
        return Promise.resolve({ count: rows.length });
      }
    }
  };
}

vi.mock('@/lib/prisma', () => {
  const base = client();
  return {
    prisma: {
      ...base,
      $transaction: (run: (tx: unknown) => Promise<unknown>) => run(client())
    }
  };
});

const USER = 'user-a';
const OTHER = 'user-b';

async function exclusions() {
  return await import('@/lib/cognitive/exclusions');
}

function inTx<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(run) as Promise<T>;
}

async function record(userId: string, sources: Array<{ content: string; chatId?: string | null }>) {
  const { recordExclusions } = await exclusions();
  return inTx((tx) => recordExclusions(tx, userId, sources));
}

beforeEach(() => {
  db.rows.clear();
  db.tick = 0;
});

describe('排除用的哈希', () => {
  it('同一句话的不同写法归一化后是同一个哈希', async () => {
    const { exclusionHash } = await exclusions();

    const base = exclusionHash(USER, '我在用 Next.js 15');
    expect(exclusionHash(USER, '我在用 next.js 15')).toBe(base);
    expect(exclusionHash(USER, '  我在用   Next.js 15 ')).toBe(base);
    expect(exclusionHash(USER, '我在用 Next.js 15。')).toBe(base);
  });

  it('换一个说法就不是同一个哈希——排除不许扩大到相似内容', async () => {
    const { exclusionHash } = await exclusions();

    expect(exclusionHash(USER, '我在用 Next.js 15')).not.toBe(exclusionHash(USER, '我在用 Next.js 14'));
  });

  it('哈希绑定用户：同一句话在两个账号下算出的值不同', async () => {
    const { exclusionHash } = await exclusions();

    expect(exclusionHash(USER, '我住在杭州')).not.toBe(exclusionHash(OTHER, '我住在杭州'));
  });

  it('哈希不含明文，也不是明文的等价物', async () => {
    const { exclusionHash } = await exclusions();

    const hash = exclusionHash(USER, '我住在杭州');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('杭州');
  });
});

describe('记录排除', () => {
  it('落库的是密文，不是明文', async () => {
    await record(USER, [{ content: '我住在杭州' }]);

    const [row] = [...db.rows.values()];
    expect(row?.contentCiphertext).not.toContain('我住在杭州');
    expect(String(row?.contentCiphertext)).toMatch(/^enc:v2:/);
  });

  it('同一句话第二次删不会多出第二行', async () => {
    await record(USER, [{ content: '我住在杭州' }]);

    await expect(record(USER, [{ content: '我住在杭州。' }])).resolves.toBe(0);

    expect(db.rows.size).toBe(1);
  });

  it('一批里重复的句子只入库一次，返回的是真正新增的条数', async () => {
    await expect(
      record(USER, [{ content: '我住在杭州' }, { content: '我在用 Prisma' }, { content: '我住在杭州 ' }])
    ).resolves.toBe(2);

    expect(db.rows.size).toBe(2);
  });

  it('空正文不入库', async () => {
    await expect(record(USER, [{ content: '   ' }])).resolves.toBe(0);

    expect(db.rows.size).toBe(0);
  });

  it('带上来源会话和来源消息，方便日后追查这条排除是哪来的', async () => {
    await record(USER, [{ content: '我住在杭州', chatId: 'chat-1' }]);

    const [row] = [...db.rows.values()];
    expect(row).toMatchObject({ userId: USER, chatId: 'chat-1' });
  });

  it('超过上限时淘汰最旧的，只动自己的行', async () => {
    const { MAX_EXCLUSIONS_PER_USER, exclusionHash } = await exclusions();
    await record(OTHER, [{ content: '别人的排除' }]);
    for (let index = 0; index < MAX_EXCLUSIONS_PER_USER; index += 1) {
      await record(USER, [{ content: `第 ${index} 条` }]);
    }
    expect(db.rows.size).toBe(MAX_EXCLUSIONS_PER_USER + 1);

    await record(USER, [{ content: '最新的一条' }]);

    const mine = [...db.rows.values()].filter((row) => row.userId === USER);
    expect(mine).toHaveLength(MAX_EXCLUSIONS_PER_USER);
    expect(mine.some((row) => row.contentHash === exclusionHash(USER, '第 0 条'))).toBe(false);
    expect(mine.some((row) => row.contentHash === exclusionHash(USER, '最新的一条'))).toBe(true);
    // 别人的行不参与淘汰
    expect([...db.rows.values()].some((row) => row.userId === OTHER)).toBe(true);
  });
});

describe('读取与撤销', () => {
  it('列表解密回显正文，只返回自己的，按时间倒序', async () => {
    await record(USER, [{ content: '我住在杭州' }]);
    await record(USER, [{ content: '我在用 Prisma' }]);
    await record(OTHER, [{ content: '别人的内容' }]);
    const { listExclusions } = await exclusions();

    const list = await listExclusions(USER);

    expect(list.map((entry) => entry.content)).toEqual(['我在用 Prisma', '我住在杭州']);
    expect(list[0]).toMatchObject({ chatId: null });
    expect(list.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true);
  });

  it('撤销自己的排除返回 true，行没了', async () => {
    await record(USER, [{ content: '我住在杭州' }]);
    const { listExclusions, removeExclusion } = await exclusions();
    const [entry] = await listExclusions(USER);

    await expect(removeExclusion(entry!.id, USER)).resolves.toBe(true);

    expect(db.rows.size).toBe(0);
  });

  it('撤销别人的排除返回 false，一行不动', async () => {
    await record(OTHER, [{ content: '别人的内容' }]);
    const { listExclusions, removeExclusion } = await exclusions();
    const [entry] = await listExclusions(OTHER);

    await expect(removeExclusion(entry!.id, USER)).resolves.toBe(false);

    expect(db.rows.size).toBe(1);
  });

  it('撤销不存在的排除返回 false，不报错', async () => {
    const { removeExclusion } = await exclusions();

    await expect(removeExclusion('nope', USER)).resolves.toBe(false);
  });

  it('写侧要用的哈希集合只含自己的', async () => {
    await record(USER, [{ content: '我住在杭州' }]);
    await record(OTHER, [{ content: '我住在杭州' }]);
    const { excludedHashes, exclusionHash } = await exclusions();

    const hashes = await excludedHashes(USER);

    expect(hashes.has(exclusionHash(USER, '我住在杭州'))).toBe(true);
    expect(hashes.has(exclusionHash(OTHER, '我住在杭州'))).toBe(false);
    expect(hashes.size).toBe(1);
  });
});
