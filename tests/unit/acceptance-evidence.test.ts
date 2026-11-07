import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 验收总计划书第 4 章的「受控数据检查」：证据检查接口。
 *
 * 两条钉子：
 *
 * 一、**只验虚拟用户。** 检查前按用户名复核 `acc_<runId>_<序号>` 前缀，
 * 真实用户名（konxing / zbh）走不到解密那一步——不是「解出来再删」，
 * 是根本不解。这是给「你可以检查真实生成的数据」开的门，
 * 门上只留虚拟用户这一条缝。
 *
 * 二、**证据是结构，不是截图。** 记忆正文走服务层解密（复用 listMemories 的
 * AAD 与隔离断言），其余表只出 count——验收判断「该记的记了没有」需要正文，
 * 判断「派生数据长没长」只需要行数，行数不解密。
 */

const db = vi.hoisted(() => ({
  users: [] as Array<{ id: string; username: string; role: string }>,
  listCalls: [] as Array<{ userId: string; filters: unknown }>,
  memories: [] as Array<Record<string, unknown>>,
  tableCounts: new Map<string, number>()
}));

vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy(
    {
      user: {
        findUnique: ({ where }: { where: { username: string } }) =>
          Promise.resolve(db.users.find((row) => row.username === where.username) ?? null)
      }
    },
    {
      get: (target, prop: string) =>
        prop in target
          ? (target as Record<string, unknown>)[prop]
          : { count: () => Promise.resolve(db.tableCounts.get(prop) ?? 0) }
    }
  )
}));

vi.mock('@/lib/cognitive/memories', () => ({
  listMemories: (userId: string, filters: unknown) => {
    db.listCalls.push({ userId, filters });
    return Promise.resolve(db.memories);
  }
}));

import { inspectVirtualUser } from '@/lib/acceptance/evidence';

beforeEach(() => {
  db.users = [];
  db.listCalls = [];
  db.memories = [];
  db.tableCounts = new Map();
});

describe('inspectVirtualUser 的门', () => {
  it('虚拟用户：放行，记忆带正文，其余表出行数', async () => {
    db.users.push({ id: 'uid-1', username: 'acc_run001_001', role: 'USER' });
    db.memories.push({ id: 'm1', content: '喜欢黑咖啡', type: 'FACT' });
    db.tableCounts.set('reflectionRecord', 2);
    db.tableCounts.set('decisionRecord', 1);

    const evidence = await inspectVirtualUser('acc_run001_001');

    expect(evidence.userId).toBe('uid-1');
    expect(evidence.memories).toHaveLength(1);
    expect(evidence.memories[0].content).toBe('喜欢黑咖啡');
    expect(evidence.counts.reflectionRecord).toBe(2);
    expect(evidence.counts.decisionRecord).toBe(1);
    // 验收要的是全量历史：被取代的旧行也得看得见。
    expect(db.listCalls[0].filters).toMatchObject({ includeSuperseded: true });
  });

  it('真实用户名：拒绝，且不解密任何记忆', async () => {
    db.users.push({ id: 'real-1', username: 'konxing', role: 'OWNER' });
    db.users.push({ id: 'real-2', username: 'zbh', role: 'USER' });

    await expect(inspectVirtualUser('konxing')).rejects.toThrow(/虚拟用户/);
    await expect(inspectVirtualUser('zbh')).rejects.toThrow(/虚拟用户/);
    expect(db.listCalls).toHaveLength(0);
  });

  it('不存在的用户名：拒绝，不当作空证据放行', async () => {
    await expect(inspectVirtualUser('acc_run009_001')).rejects.toThrow();
    expect(db.listCalls).toHaveLength(0);
  });
});
