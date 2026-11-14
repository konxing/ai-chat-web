import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 验收总计划书第 3 章：虚拟用户的创建与清理。
 *
 * 三条钉子：
 *
 * 一、**前缀就是隔离墙。** 虚拟用户名一律 `acc_<runId>_<序号>`，清理只认这个前缀，
 * 而且逐行复核角色——一行 OWNER 混进来也不删。真实用户账号（konxing / zbh）
 * 不在前缀里，路径上根本够不到。
 *
 * 二、**runId 不合法就什么都不做。** 太短、带大写、带符号的 runId 会让
 * `startsWith` 匹配面变大（极端情况 runId 为空串就匹配所有 acc_ 用户），
 * 所以创建和清理两道门都要先校验格式。
 *
 * 三、**清理要出残留报告。** user.delete 靠外键 cascade 收走派生数据，
 * 但「cascade 真的覆盖每张认知表」不能靠 schema 口头保证——清理完逐表 count 一遍，
 * 残留为 0 才算清完；不为 0 的表名要进报告，不许静默。
 */

const db = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  creates: [] as Array<Record<string, unknown>>,
  deletes: [] as string[],
  residue: new Map<string, number>(),
  hashes: [] as string[]
}));

vi.mock('@/lib/prisma', () => {
  const user = {
    create: ({ data }: { data: Record<string, unknown> }) => {
      db.creates.push(data);
      const row = { id: `uid-${db.creates.length}`, ...data };
      db.users.push(row);
      return Promise.resolve(row);
    },
    findMany: ({ where }: { where?: { username?: { startsWith?: string } } }) => {
      const prefix = where?.username?.startsWith;
      return Promise.resolve(
        prefix ? db.users.filter((row) => String(row.username).startsWith(prefix)) : [...db.users]
      );
    },
    delete: ({ where }: { where: { id: string } }) => {
      db.deletes.push(where.id);
      db.users = db.users.filter((row) => row.id !== where.id);
      return Promise.resolve({});
    }
  };
  const residueTable = (name: string) => ({
    count: () => Promise.resolve(db.residue.get(name) ?? 0)
  });
  return {
    prisma: new Proxy(
      { user },
      {
        get: (target, prop: string) =>
          prop in target
            ? (target as Record<string, unknown>)[prop]
            : residueTable(prop)
      }
    )
  };
});

vi.mock('@/lib/password', () => ({
  hashPassword: (password: string) => {
    db.hashes.push(password);
    return Promise.resolve(`hashed:${password}`);
  }
}));

import {
  acceptanceUsername,
  cleanupVirtualUsers,
  createVirtualUsers,
  isAcceptanceUsername
} from '@/lib/acceptance/virtual-users';

beforeEach(() => {
  db.users = [];
  db.creates = [];
  db.deletes = [];
  db.residue = new Map();
  db.hashes = [];
});

describe('用户名口径', () => {
  it('用户名是 acc_<runId>_<三位序号>，总长不超过 32', () => {
    expect(acceptanceUsername('run001', 1)).toBe('acc_run001_001');
    expect(acceptanceUsername('run001', 12)).toBe('acc_run001_012');
    expect(acceptanceUsername('abcdefghijklmnop', 999)).toHaveLength(24);
    expect(isAcceptanceUsername('acc_run001_001')).toBe(true);
  });

  it('真实用户名与畸形名都不被认成虚拟用户', () => {
    expect(isAcceptanceUsername('konxing')).toBe(false);
    expect(isAcceptanceUsername('zbh')).toBe(false);
    expect(isAcceptanceUsername('acc_')).toBe(false);
    expect(isAcceptanceUsername('acc_run001')).toBe(false);
    expect(isAcceptanceUsername('acc_run001_1')).toBe(false);
    expect(isAcceptanceUsername('acc_RUN001_001')).toBe(false);
  });
});

describe('createVirtualUsers', () => {
  it('建出 N 个 role=USER 的账号，密码只经哈希落库，明文只从返回值出去一次', async () => {
    const created = await createVirtualUsers({ runId: 'run001', count: 3 });
    expect(created).toHaveLength(3);
    expect(db.creates.map((row) => row.username)).toEqual([
      'acc_run001_001',
      'acc_run001_002',
      'acc_run001_003'
    ]);
    for (const row of db.creates) {
      expect(row.role).toBe('USER');
      expect(row.status).toBe('ACTIVE');
      expect(String(row.email)).toMatch(/@acceptance\.invalid$/);
      expect(String(row.passwordHash)).toMatch(/^hashed:/);
    }
    // 每个用户一份独立明文密码，只出现在返回值里，不落库。
    expect(new Set(created.map((entry) => entry.password)).size).toBe(3);
    expect(db.hashes).toEqual(created.map((entry) => entry.password));
  });

  it('runId 不合法：一个用户都不建', async () => {
    await expect(createVirtualUsers({ runId: '', count: 1 })).rejects.toThrow();
    await expect(createVirtualUsers({ runId: 'ABC123', count: 1 })).rejects.toThrow();
    await expect(createVirtualUsers({ runId: 'a b', count: 1 })).rejects.toThrow();
    expect(db.creates).toHaveLength(0);
  });
});

describe('cleanupVirtualUsers', () => {
  it('只删本 runId 前缀的账号，别的 runId 与真实账号一行不动', async () => {
    await createVirtualUsers({ runId: 'run001', count: 2 });
    await createVirtualUsers({ runId: 'run002', count: 1 });
    db.users.push({ id: 'real-1', username: 'konxing', role: 'OWNER' });
    db.users.push({ id: 'real-2', username: 'zbh', role: 'USER' });

    const report = await cleanupVirtualUsers({ runId: 'run001' });

    expect(db.deletes.sort()).toEqual(['uid-1', 'uid-2']);
    expect(db.users.map((row) => row.username).sort()).toEqual([
      'acc_run002_001',
      'konxing',
      'zbh'
    ]);
    expect(report.deletedUsers).toBe(2);
    expect(report.residue).toEqual({});
  });

  it('前缀撞上但角色是 OWNER 的行：拒删，整轮中止', async () => {
    db.users.push({ id: 'evil', username: 'acc_run001_999', role: 'OWNER' });

    await expect(cleanupVirtualUsers({ runId: 'run001' })).rejects.toThrow(/OWNER/);
    expect(db.deletes).toHaveLength(0);
  });

  it('runId 不合法：什么都不删', async () => {
    db.users.push({ id: 'uid-1', username: 'acc_run001_001', role: 'USER' });
    await expect(cleanupVirtualUsers({ runId: '' })).rejects.toThrow();
    await expect(cleanupVirtualUsers({ runId: 'RUN001' })).rejects.toThrow();
    expect(db.deletes).toHaveLength(0);
  });

  it('删除后有表残留：表名和行数进报告，不许静默', async () => {
    await createVirtualUsers({ runId: 'run001', count: 1 });
    db.residue.set('memoryItem', 2);
    db.residue.set('reflectionRecord', 1);

    const report = await cleanupVirtualUsers({ runId: 'run001' });

    expect(report.deletedUsers).toBe(1);
    expect(report.residue).toEqual({ memoryItem: 2, reflectionRecord: 1 });
  });
});
