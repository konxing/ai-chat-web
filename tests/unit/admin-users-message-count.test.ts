import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 管理台用户页每个用户要显示「消息数」。现在的写法是：先按 chatId 把消息分组，
 * 再把这一页用户的**全部聊天行**拉回 Node 建 chatId→userId 映射，然后在内存里加总。
 * 于是翻页一次拉回的行数 = 这些用户的聊天数 × 2，和页大小无关、和用户聊得多少有关。
 *
 * 这里钉两件事：
 * 1. 每个用户的消息数仍然算得对（含 0、含不在本页的用户不能串味）；
 * 2. 为算消息数拉回 Node 的行数不再随聊天数增长，只和这一页的用户数同量级。
 */
type Chat = { id: string; userId: string };
type Store = { users: Record<string, unknown>[]; chats: Chat[]; messagesPerChat: Record<string, number> };

const probe = vi.hoisted(() => ({
  store: { users: [], chats: [], messagesPerChat: {} } as Store,
  pageUserIds: [] as string[],
  countingRows: 0,
  chatListQueries: 0
}));

vi.mock('@/lib/prisma', () => {
  const toUserRow = (id: string) => {
    const chats = probe.store.chats.filter((c) => c.userId === id);
    return {
      id,
      username: id,
      email: `${id}@family.test`,
      emailVerified: true,
      role: 'USER',
      status: 'ACTIVE',
      displayName: null,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      _count: { chats: chats.length, aiProviders: 0, sessions: 1 }
    };
  };

  const aggregate = () =>
    [...new Set(probe.store.chats.map((c) => c.userId))].map((userId) => ({
      userId,
      messages: probe.store.chats
        .filter((c) => c.userId === userId)
        .reduce((sum, c) => sum + (probe.store.messagesPerChat[c.id] ?? 0), 0)
    }));

  return {
    prisma: {
      user: {
        findMany: () => Promise.resolve(probe.pageUserIds.map(toUserRow)),
        count: () => Promise.resolve(probe.pageUserIds.length)
      },
      chat: {
        findMany: () => {
          probe.chatListQueries += 1;
          // 模拟旧写法：整页用户的每一行聊天都被送回 Node。
          const rows = probe.store.chats.filter((c) => probe.pageUserIds.includes(c.userId));
          probe.countingRows += rows.length;
          return Promise.resolve(rows.map((c) => ({ id: c.id, userId: c.userId })));
        }
      },
      message: {
        groupBy: () => {
          const rows = probe.store.chats
            .filter((c) => probe.pageUserIds.includes(c.userId))
            .map((c) => ({ chatId: c.id, _count: { _all: probe.store.messagesPerChat[c.id] ?? 0 } }));
          probe.countingRows += rows.length;
          return Promise.resolve(rows);
        }
      },
      $queryRaw: (strings: unknown, ...values: unknown[]) => {
        const sql = (Array.isArray(strings) ? strings.join('') : String(strings)) + values.join(' ');
        if (!/"Message"/i.test(sql) || !/group by/i.test(sql)) return Promise.resolve([]);
        const rows = aggregate();
        probe.countingRows += rows.length;
        return Promise.resolve(rows);
      }
    }
  };
});

async function loadAdmin() {
  vi.resetModules();
  return await import('@/lib/admin');
}

function seed(countsByUser: Record<string, number[]>) {
  const chats: Chat[] = [];
  const messagesPerChat: Record<string, number> = {};
  for (const [userId, perChat] of Object.entries(countsByUser)) {
    perChat.forEach((count, index) => {
      const id = `${userId}-c${index}`;
      chats.push({ id, userId });
      messagesPerChat[id] = count;
    });
  }
  probe.store = { users: [], chats, messagesPerChat };
}

describe('管理台用户页的消息数', () => {
  beforeEach(() => {
    probe.countingRows = 0;
    probe.chatListQueries = 0;
    probe.pageUserIds = [];
    probe.store = { users: [], chats: [], messagesPerChat: {} };
  });

  it('每个用户算到自己头上，0 条也是 0 条', async () => {
    // u9 不在本页：它的 99 条不许混进任何一个人的数字。
    seed({ u1: [2, 3, 2], u2: [1, 2], u3: [0], u9: [99] });
    probe.pageUserIds = ['u1', 'u2', 'u3'];

    const { listUsers } = await loadAdmin();
    const result = await listUsers(new URL('http://local.test/api/admin/users'));

    expect(result.items.map((u) => u.messages)).toEqual([7, 3, 0]);
    expect(result.items.map((u) => u.chats)).toEqual([3, 2, 1]);
  });

  it('翻页拉回的行数只跟这页有几个用户有关，不跟他们有多少条聊天有关', async () => {
    seed({ u1: Array.from({ length: 200 }, () => 1) });
    probe.pageUserIds = ['u1'];

    const { listUsers } = await loadAdmin();
    const result = await listUsers(new URL('http://local.test/api/admin/users'));

    expect(result.items[0].messages).toBe(200);
    expect(probe.countingRows).toBeLessThanOrEqual(result.items.length);
  });

  it('这一页没有用户时不去查消息数', async () => {
    seed({ u1: [5] });
    probe.pageUserIds = [];

    const { listUsers } = await loadAdmin();
    const result = await listUsers(new URL('http://local.test/api/admin/users'));

    expect(result.items).toEqual([]);
    expect(probe.countingRows).toBe(0);
  });
});
