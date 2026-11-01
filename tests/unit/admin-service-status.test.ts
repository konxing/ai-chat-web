import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ sql: [] as string[], failSize: false }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: (strings: unknown, ...values: unknown[]) => {
      const sql = (Array.isArray(strings) ? strings.join('') : String(strings)) + values.join(' ');
      probe.sql.push(sql.trim());
      if (/pg_database_size/i.test(sql)) {
        return probe.failSize
          ? Promise.reject(new Error('permission denied for function pg_database_size'))
          : Promise.resolve([{ size: 9180851n }]);
      }
      if (/server_version/i.test(sql)) return Promise.resolve([{ server_version: '17.11 (test)' }]);
      return Promise.resolve([{ ok: 1 }]);
    }
  }
}));

async function loadAdmin() {
  vi.resetModules();
  return await import('@/lib/admin');
}

const sizeQueries = () => probe.sql.filter((s) => /pg_database_size/i.test(s));

describe('getServiceStatus 的数据库体积查询', () => {
  beforeEach(() => {
    probe.sql = [];
    probe.failSize = false;
    vi.useRealTimers();
  });

  it('同一个 TTL 窗口内只查一次，第二次复用缓存', async () => {
    const { getServiceStatus } = await loadAdmin();
    const first = await getServiceStatus();
    const second = await getServiceStatus();

    expect(sizeQueries()).toHaveLength(1);
    expect(first.database.sizeBytes).toBe(9180851);
    expect(second.database.sizeBytes).toBe(9180851);
    expect(second.database.version).toBe('17.11 (test)');
  });

  it('TTL 过期后重新查询', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
    const { getServiceStatus } = await loadAdmin();
    await getServiceStatus();
    vi.setSystemTime(new Date('2026-11-01T12:01:01.000Z'));
    const second = await getServiceStatus();

    expect(sizeQueries()).toHaveLength(2);
    expect(second.database.sizeBytes).toBe(9180851);
  });

  it('查询失败不写缓存，下一次仍然尝试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
    const { getServiceStatus } = await loadAdmin();

    probe.failSize = true;
    const failed = await getServiceStatus();
    expect(failed.database.sizeBytes).toBeNull();
    expect(sizeQueries()).toHaveLength(1);

    probe.failSize = false;
    const recovered = await getServiceStatus();
    expect(sizeQueries()).toHaveLength(2);
    expect(recovered.database.sizeBytes).toBe(9180851);
  });
});
