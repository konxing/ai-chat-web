import { prisma } from '@/lib/prisma';
import { evaluateLock, nextLockState, type LockVerdict } from '@/lib/login-lock';

export async function checkLoginLock(ip: string): Promise<LockVerdict> {
  const row = await prisma.loginLock.findUnique({ where: { ip } });
  return evaluateLock(row, Date.now());
}

export async function registerLoginFailure(ip: string): Promise<LockVerdict> {
  const now = Date.now();
  const current = await prisma.loginLock.findUnique({ where: { ip } });
  const next = nextLockState(current, now);
  const row = await prisma.loginLock.upsert({
    where: { ip },
    create: { ip, ...next },
    update: next
  });
  return evaluateLock(row, now);
}

export async function clearLoginLock(ip: string): Promise<void> {
  await prisma.loginLock.deleteMany({ where: { ip } });
}

export async function listActiveLoginLocks() {
  return prisma.loginLock.findMany({
    where: { lockedUntil: { gt: new Date() } },
    orderBy: { lockedUntil: 'desc' },
    take: 100
  });
}

export async function releaseLoginLocks(ip?: string): Promise<number> {
  const result = await prisma.loginLock.deleteMany({ where: ip ? { ip } : {} });
  return result.count;
}
