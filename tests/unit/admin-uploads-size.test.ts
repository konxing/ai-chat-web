import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * getOverview 把 uploads 目录的整棵递归 stat 塞进了管理台首屏那一个请求里，
 * 只为算出 storage.uploadsBytes 这个展示数字——和已经修掉的 pg_database_size 同一类。
 * 这里钉住：60 秒内复用上一次扫描结果，窗口过后重新扫，真实字节数仍然算得对。
 */
const probe = vi.hoisted(() => ({ scans: 0 }));

vi.mock('@/lib/prisma', () => {
  const zero = Promise.resolve(0);
  return {
    prisma: {
      $queryRaw: (strings: unknown, ...values: unknown[]) => {
        const sql = (Array.isArray(strings) ? strings.join('') : String(strings)) + values.join(' ');
        if (/pg_database_size/i.test(sql)) return Promise.resolve([{ size: 1234n }]);
        if (/server_version/i.test(sql)) return Promise.resolve([{ server_version: '17.11 (test)' }]);
        return Promise.resolve([{ ok: 1 }]);
      },
      user: { count: () => zero },
      chat: { count: () => zero },
      message: { count: () => zero },
      session: { count: () => zero },
      ipRule: { count: () => zero },
      loginLog: { count: () => zero },
      ipAccessLog: { count: () => zero },
      aiProvider: { count: () => zero },
      attachment: {
        count: () => zero,
        aggregate: () => Promise.resolve({ _sum: { size: 0 } })
      }
    }
  };
});

let dir = '';

async function loadAdmin() {
  vi.resetModules();
  return await import('@/lib/admin');
}

describe('管理台首屏的 uploads 体积', () => {
  beforeEach(async () => {
    probe.scans = 0;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fac-uploads-'));
    await fs.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    await fs.writeFile(path.join(dir, 'b.bin'), Buffer.alloc(2000));
    process.env.UPLOAD_DIR = dir;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('第一次真扫，报出目录里的真实字节数', async () => {
    const { getOverview } = await loadAdmin();
    const overview = await getOverview();

    expect(overview.storage.uploadsBytes).toBe(3000);
  });

  it('60 秒内再来一次不重扫，目录变了也用缓存里的数字', async () => {
    const { getOverview } = await loadAdmin();
    const first = await getOverview();

    await fs.writeFile(path.join(dir, 'c.bin'), Buffer.alloc(5000));
    vi.setSystemTime(new Date('2026-11-01T12:00:59.000Z'));
    const second = await getOverview();

    expect(first.storage.uploadsBytes).toBe(3000);
    expect(second.storage.uploadsBytes).toBe(3000);
  });

  it('过了缓存窗口会重新扫，把新增文件算进去', async () => {
    const { getOverview } = await loadAdmin();
    await getOverview();

    await fs.writeFile(path.join(dir, 'c.bin'), Buffer.alloc(5000));
    vi.setSystemTime(new Date('2026-11-01T12:01:01.000Z'));
    const refreshed = await getOverview();

    expect(refreshed.storage.uploadsBytes).toBe(8000);
  });
});
