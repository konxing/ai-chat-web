import type { User } from '@prisma/client';
import { ApiError, assertSameOrigin } from './http';
import { getSession, verifyCsrfToken, type SessionWithUser } from './session';
import { verifyPassword } from './password';

export interface AuthContext {
  user: User;
  session: SessionWithUser;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function requireUser(req: Request, opts: { csrf?: boolean } = {}): Promise<AuthContext> {
  const session = await getSession();
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
  if (MUTATING.has(req.method)) {
    assertSameOrigin(req);
    if (opts.csrf !== false) {
      const token = req.headers.get('x-csrf-token');
      if (!verifyCsrfToken(session, token)) {
        throw new ApiError(403, 'CSRF_FAILED', '安全令牌校验失败，请刷新页面后重试');
      }
    }
  }
  return { user: session.user, session };
}

export async function requireOwner(req: Request, opts: { csrf?: boolean } = {}): Promise<AuthContext> {
  const ctx = await requireUser(req, opts);
  if (ctx.user.role !== 'OWNER') {
    throw new ApiError(403, 'FORBIDDEN', '仅超级管理员可执行此操作');
  }
  return ctx;
}

export async function requireOwnerPassword(userId: string, password: unknown): Promise<void> {
  if (typeof password !== 'string' || password.length === 0 || password.length > 200) {
    throw new ApiError(400, 'PASSWORD_REQUIRED', '此操作需要输入当前管理员密码');
  }
  const { prisma } = await import('./prisma');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, status: true, role: true }
  });
  if (!user || user.role !== 'OWNER' || user.status !== 'ACTIVE') {
    throw new ApiError(403, 'FORBIDDEN', '管理员账号状态异常');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) throw new ApiError(403, 'REAUTH_FAILED', '密码验证失败');
}

export async function getPageUser(): Promise<User | null> {
  const session = await getSession();
  return session?.user ?? null;
}
