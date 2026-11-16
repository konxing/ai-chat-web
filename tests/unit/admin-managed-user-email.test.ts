import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  audit: vi.fn()
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: calls.findFirst, create: calls.create } } }));
vi.mock('@/lib/auth', () => ({
  requireOwner: async () => ({ user: { id: 'admin-id', username: 'owner' } }),
  requireOwnerPassword: async () => undefined
}));
vi.mock('@/lib/password', () => ({ hashPassword: async () => 'password-hash' }));
vi.mock('@/lib/audit', () => ({ writeAudit: calls.audit }));

import { POST } from '@/app/api/admin/users/route';

function createUser(email: unknown) {
  return POST(new Request('http://127.0.0.1:3000/api/admin/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', confirmPassword: 'admin-password', email })
  }));
}

describe('administrator-created account emails', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    calls.findFirst.mockResolvedValue(null);
    calls.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'new-member-id',
      lastLoginAt: null,
      createdAt: new Date()
    }));
  });

  it.each([undefined, null, '  '])('stores no email for %s without matching other unbound users', async (email) => {
    const response = await createUser(email);
    expect(response.status).toBe(200);
    expect(calls.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { username: 'member' } }));
    expect(calls.create).toHaveBeenCalledWith({ data: expect.objectContaining({ email: null, emailVerified: null }) });
    expect((await response.json()).data.user).toMatchObject({ email: null, emailVerified: false });
  });

  it('normalizes the given email and makes it usable without an email verification flow', async () => {
    const response = await createUser(' Member@Example.com ');
    expect(response.status).toBe(200);
    expect((await response.json()).data.user).toMatchObject({ email: 'member@example.com', emailVerified: true });
  });

  it('validates an address when one is provided', async () => {
    const response = await createUser('invalid-email');
    expect(response.status).toBe(400);
    expect(calls.create).not.toHaveBeenCalled();
  });

  it('reports a unique conflict when another request takes the address before creation', async () => {
    calls.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate email', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['email'] }
    }));
    const response = await createUser('member@example.com');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: 'USER_EXISTS', message: '邮箱已被注册' });
  });
});
