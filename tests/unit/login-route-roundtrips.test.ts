import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 登录成功路径上互不依赖的读写（解锁、建会话、更新最后登录、写登录日志、取公共配置）
 * 目前是一条一条 await。这组测试钉住两件事：
 * 1) 它们必须同时在飞（串行改并行）；
 * 2) 并行之后，仍有的先后依赖不能丢——审计要用真实 sessionId、禁用账号/错密码不能建会话。
 */
const ctx = vi.hoisted(() => ({
  events: [] as string[],
  audit: [] as Record<string, unknown>[],
  loginLogs: [] as Record<string, unknown>[],
  cookieSet: [] as string[],
  passwordHash: '',
  status: 'ACTIVE' as string,
  role: 'OWNER' as string
}));

const USER_ID = 'user-1';
const SESSION_ID = 'sess-1';
const PASSWORD = 'Correct-Horse-7';

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

function userRow() {
  return {
    id: USER_ID,
    username: 'konxing',
    email: 'konxing@example.com',
    displayName: 'konxing',
    role: ctx.role,
    status: ctx.status,
    emailVerified: null,
    passwordHash: ctx.passwordHash,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z')
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findFirst: () => inFlight('user.findFirst', userRow),
      update: ({ data }: { data: { lastLoginAt: Date } }) =>
        inFlight('user.update', () => ({ ...userRow(), lastLoginAt: data.lastLoginAt }))
    },
    session: {
      create: () =>
        inFlight('session.create', () => ({
          id: SESSION_ID,
          userId: USER_ID,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 30 * 86400_000)
        }))
    },
    loginLog: {
      create: ({ data }: { data: Record<string, unknown> }) =>
        inFlight('loginLog.create', () => {
          ctx.loginLogs.push(data);
          return data;
        })
    },
    loginLock: {
      findUnique: () => inFlight('loginLock.findUnique', () => null),
      deleteMany: () => inFlight('loginLock.deleteMany', () => ({ count: 0 })),
      upsert: () => inFlight('loginLock.upsert', () => null)
    },
    systemConfig: {
      findMany: () => inFlight('systemConfig.findMany', () => []),
      findUnique: () => inFlight('systemConfig.findUnique', () => null)
    },
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) =>
        inFlight('auditLog.create', () => {
          ctx.audit.push(data);
          return data;
        })
    }
  }
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    delete: () => undefined,
    set: (name: string) => {
      ctx.cookieSet.push(name);
    }
  })
}));

async function login(ip: string, password = PASSWORD) {
  const { POST } = await import('@/app/api/auth/login/route');
  const request = new Request('http://127.0.0.1:3000/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3000',
      'x-client-ip': ip,
      'user-agent': 'vitest'
    },
    body: JSON.stringify({ identifier: 'konxing', password })
  });
  return POST(request);
}

/** 标签都在飞之后再有任何一个落地，才叫并行。 */
function overlapGap(labels: string[]) {
  const starts = labels.map((label) => ctx.events.indexOf(`${label}:start`));
  const ends = labels.map((label) => ctx.events.indexOf(`${label}:end`));
  expect(starts.every((index) => index >= 0)).toBe(true);
  expect(ends.every((index) => index >= 0)).toBe(true);
  return { lastStart: Math.max(...starts), firstEnd: Math.min(...ends) };
}

describe('登录成功路径的往返次序', () => {
  beforeAll(async () => {
    const { hashPassword } = await import('@/lib/password');
    ctx.passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(() => {
    ctx.events = [];
    ctx.audit = [];
    ctx.loginLogs = [];
    ctx.cookieSet = [];
    ctx.status = 'ACTIVE';
    ctx.role = 'OWNER';
  });

  it('解锁、建会话、更新最后登录、取配置同时在飞', async () => {
    const response = await login('203.0.113.11');
    expect(response.status).toBe(200);

    const { lastStart, firstEnd } = overlapGap([
      'loginLock.deleteMany',
      'session.create',
      'user.update',
      'systemConfig.findMany'
    ]);
    expect(lastStart).toBeLessThan(firstEnd);
  });

  it('成功登录日志要等会话真的落地之后再写，但和审计同时在飞', async () => {
    await login('203.0.113.17');

    const createdEnd = ctx.events.indexOf('session.create:end');
    expect(ctx.events.indexOf('loginLog.create:start')).toBeGreaterThan(createdEnd);
    expect(ctx.events.indexOf('auditLog.create:start')).toBeGreaterThan(createdEnd);
    const { lastStart, firstEnd } = overlapGap(['loginLog.create', 'auditLog.create']);
    expect(lastStart).toBeLessThan(firstEnd);
  });

  it('并行之后审计仍带上真实 sessionId，且发生在会话落地之后', async () => {
    await login('203.0.113.12');

    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].action).toBe('owner.login');
    expect(ctx.audit[0].targetId).toBe(SESSION_ID);
    expect(ctx.events.indexOf('auditLog.create:start')).toBeGreaterThan(
      ctx.events.indexOf('session.create:end')
    );
  });

  it('响应仍带上会话 cookie 与用户/配置负载', async () => {
    const response = await login('203.0.113.13');
    const payload = (await response.json()) as { data: { user: { id: string }; settings: { siteName: string } } };

    expect(ctx.cookieSet).toContain('fac_session');
    expect(ctx.cookieSet).toContain('fac_csrf');
    expect(payload.data.user.id).toBe(USER_ID);
    expect(payload.data.settings.siteName).toBeTruthy();
  });

  it('账号被禁用时不建会话、不解锁、不写成功日志', async () => {
    ctx.status = 'DISABLED';
    const response = await login('203.0.113.14');

    expect(response.status).toBe(403);
    expect(ctx.events).not.toContain('session.create:start');
    expect(ctx.events).not.toContain('loginLock.deleteMany:start');
    expect(ctx.loginLogs.some((row) => row.success === true)).toBe(false);
  });

  it('密码错误时不建会话，只落一条失败日志并计入锁定', async () => {
    const response = await login('203.0.113.15', 'Wrong-Battery-3');

    expect(response.status).toBe(401);
    expect(ctx.events).not.toContain('session.create:start');
    expect(ctx.events).not.toContain('user.update:start');
    expect(ctx.loginLogs).toHaveLength(1);
    expect(ctx.loginLogs[0]).toMatchObject({ success: false, reason: 'bad_password' });
    expect(ctx.events).toContain('loginLock.upsert:start');
  });

  it('非 OWNER 用户登录不写审计', async () => {
    ctx.role = 'MEMBER';
    const response = await login('203.0.113.16');

    expect(response.status).toBe(200);
    expect(ctx.audit).toHaveLength(0);
  });
});
