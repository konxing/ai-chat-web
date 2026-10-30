import { cookies } from 'next/headers';
import type { Session, User } from '@prisma/client';
import { prisma } from './prisma';
import { randomToken, safeEqualHex, sha256Hex } from './crypto';
import { loadEnv } from './env';
import { log } from './logger';

export const SESSION_COOKIE = 'fac_session';
export const CSRF_COOKIE = 'fac_csrf';
const SESSION_DAYS = 30;

export type SessionWithUser = Session & { user: User };

export interface CreatedSession {
  token: string;
  csrfToken: string;
  session: Session;
  expiresAt: Date;
}

export function hashSessionToken(token: string): string {
  return sha256Hex(token);
}

export function cookieOptions(maxAgeSeconds: number) {
  const env = loadEnv();
  return {
    httpOnly: true,
    secure: env.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds
  };
}

export function csrfCookieOptions(maxAgeSeconds: number) {
  const env = loadEnv();
  return {
    httpOnly: false,
    secure: env.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds
  };
}

export async function createSession(input: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<CreatedSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      csrfHash: sha256Hex(csrfToken),
      userId: input.userId,
      ip: input.ip?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      expiresAt
    }
  });
  return { token, csrfToken, session, expiresAt };
}

export async function setSessionCookies(created: CreatedSession): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, created.token, cookieOptions(SESSION_DAYS * 86400));
  store.set(CSRF_COOKIE, created.csrfToken, csrfCookieOptions(SESSION_DAYS * 86400));
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...cookieOptions(0), maxAge: 0 });
  store.set(CSRF_COOKIE, '', { ...csrfCookieOptions(0), maxAge: 0 });
}

export async function getSession(): Promise<SessionWithUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true }
  });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.user.status !== 'ACTIVE') return null;

  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
    prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch((err) => log.warn('session.touch_failed', { error: String(err) }));
  }
  return session;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {})
    },
    data: { revokedAt: new Date() }
  });
  return result.count;
}

export function verifyCsrfToken(session: Session, headerValue: string | null): boolean {
  if (!headerValue) return false;
  const hash = sha256Hex(headerValue);
  return safeEqualHex(hash, session.csrfHash);
}
