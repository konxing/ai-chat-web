import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolveDefaultProvider 原本是四级短路：用户默认 → 配置指定 → 全局默认 → 任一全局，
 * 每级一条 findFirst，最坏四次串行往返。改成一次候选查询 + 一次配置查询并行，
 * 内存里按同样的优先级挑。
 * 这里要钉住两件事：挑出来的必须是同一个那一个，且候选范围不能因为合并查询而放宽
 * ——别人的私有 provider 绝不能进入解析。
 */
const ctx = vi.hoisted(() => ({
  events: [] as string[],
  findFirst: 0,
  findMany: 0,
  configReads: 0,
  configuredId: null as string | null,
  providers: [] as Array<Record<string, unknown>>
}));

const USER = 'user-me';

function inFlight<T>(label: string, make: () => T) {
  ctx.events.push(`${label}:start`);
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      ctx.events.push(`${label}:end`);
      try {
        resolve(make());
      } catch (err) {
        reject(err);
      }
    }, 2);
  });
}

function provider(id: string, ownerType: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerType,
    userId: ownerType === 'USER' ? USER : null,
    name: id,
    baseUrl: 'https://example.invalid/v1',
    apiKeyCiphertext: 'enc:v1:test1:AAA:BBB:CCC',
    modelId: 'some-model',
    capabilities: ['text'],
    params: null,
    enabled: true,
    isDefault: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

/** 只认识「enabled + OR:[GLOBAL, USER:userId]」这一种形状，别的形状直接报错，避免假客户端默默放行。 */
function pickCandidates(where: Record<string, any>) {
  if (where.enabled !== true || !Array.isArray(where.OR)) {
    throw new Error(`unrecognised candidate where: ${JSON.stringify(where)}`);
  }
  const userArm = where.OR.find((arm) => arm.ownerType === 'USER');
  if (!userArm || typeof userArm.userId !== 'string') {
    throw new Error('candidate where lost the owning userId');
  }
  return ctx.providers
    .filter((p) => p.enabled === true)
    .filter((p) => p.ownerType === 'GLOBAL' || (p.ownerType === 'USER' && p.userId === userArm.userId))
    .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
}

const KNOWN_COLUMNS = new Set(['id', 'ownerType', 'userId', 'enabled', 'isDefault']);

/** 让旧的逐级 findFirst 也能在这台假数据库上跑出真实结果，这样「挑哪一个」的测试才是行为测试。 */
function firstMatch(where: Record<string, any>) {
  for (const key of Object.keys(where)) {
    if (!KNOWN_COLUMNS.has(key)) throw new Error(`unrecognised findFirst where key: ${key}`);
  }
  return ctx.providers
    .filter((p) => Object.entries(where).every(([key, value]) => p[key] === value))
    .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())[0];
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    aiProvider: {
      findFirst: (args: { where: Record<string, any> }) => {
        ctx.findFirst += 1;
        return Promise.resolve(firstMatch(args.where) ?? null);
      },
      findMany: (args: { where: Record<string, any> }) =>
        inFlight('aiProvider.findMany', () => {
          ctx.findMany += 1;
          return pickCandidates(args.where);
        })
    },
    systemConfig: {
      findUnique: () =>
        inFlight('systemConfig.findUnique', () => {
          ctx.configReads += 1;
          return ctx.configuredId ? { key: 'defaultProviderId', value: ctx.configuredId } : null;
        })
    }
  }
}));

async function resolve(userId = USER) {
  const { resolveDefaultProvider } = await import('@/lib/providers');
  return resolveDefaultProvider(userId);
}

describe('默认模型解析', () => {
  beforeEach(() => {
    ctx.events = [];
    ctx.findFirst = 0;
    ctx.findMany = 0;
    ctx.configReads = 0;
    ctx.configuredId = null;
    ctx.providers = [];
  });

  it('一次候选查询加一次配置查询就出结果，不再逐级 findFirst', async () => {
    ctx.providers = [provider('p-global-default', 'GLOBAL', { isDefault: true })];

    const picked = await resolve();

    expect(picked.id).toBe('p-global-default');
    expect(ctx.findFirst).toBe(0);
    expect(ctx.findMany).toBe(1);
    expect(ctx.configReads).toBe(1);
    expect(ctx.events.indexOf('aiProvider.findMany:start')).toBeLessThan(
      ctx.events.indexOf('systemConfig.findUnique:end')
    );
  });

  it('用户自己的默认优先于已配置的全局默认', async () => {
    ctx.providers = [
      provider('p-my-default', 'USER', { isDefault: true }),
      provider('p-global-default', 'GLOBAL', { isDefault: true })
    ];
    ctx.configuredId = 'p-global-default';

    expect((await resolve()).id).toBe('p-my-default');
  });

  it('没有用户默认时用配置指定的那个全局', async () => {
    ctx.providers = [
      provider('p-global-plain', 'GLOBAL'),
      provider('p-global-configured', 'GLOBAL')
    ];
    ctx.configuredId = 'p-global-configured';

    expect((await resolve()).id).toBe('p-global-configured');
  });

  it('配置指向禁用的或不存在的全局时回落到标记默认的那个', async () => {
    ctx.providers = [
      provider('p-gone', 'GLOBAL'),
      provider('p-oldest', 'GLOBAL'),
      provider('p-marked-default', 'GLOBAL', { isDefault: true })
    ];
    ctx.configuredId = 'p-missing';

    expect((await resolve()).id).toBe('p-marked-default');
  });

  it('谁都没标默认时取最早创建的那个全局', async () => {
    ctx.providers = [
      provider('p-newer', 'GLOBAL', { createdAt: new Date('2026-05-05T00:00:00.000Z') }),
      provider('p-older', 'GLOBAL', { createdAt: new Date('2026-02-02T00:00:00.000Z') })
    ];

    expect((await resolve()).id).toBe('p-older');
  });

  it('用户的默认被禁用时跳过它，改用全局', async () => {
    ctx.providers = [
      provider('p-my-disabled', 'USER', { isDefault: true, enabled: false }),
      provider('p-global-default', 'GLOBAL', { isDefault: true })
    ];

    expect((await resolve()).id).toBe('p-global-default');
  });

  it('同一个人有多个标了默认的候选时取最早创建的那个', async () => {
    ctx.providers = [
      provider('p-mine-newer', 'USER', {
        isDefault: true,
        createdAt: new Date('2026-06-06T00:00:00.000Z')
      }),
      provider('p-mine-older', 'USER', {
        isDefault: true,
        createdAt: new Date('2026-03-03T00:00:00.000Z')
      })
    ];

    expect((await resolve()).id).toBe('p-mine-older');
  });

  it('别人的私有 provider 即使标了默认也不参与解析', async () => {
    ctx.providers = [
      provider('p-someone-else', 'USER', { userId: 'user-other', isDefault: true }),
      provider('p-global-default', 'GLOBAL', { isDefault: true })
    ];

    expect((await resolve()).id).toBe('p-global-default');
  });

  it('一个可用模型都没有时抛 NO_MODEL', async () => {
    ctx.providers = [provider('p-disabled', 'GLOBAL', { enabled: false })];

    await expect(resolve()).rejects.toMatchObject({ code: 'NO_MODEL', status: 400 });
  });
});
