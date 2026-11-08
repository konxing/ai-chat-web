import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';

export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'DISPUTED' | 'REFUTED';
export type Volatility = 'LOW' | 'MEDIUM' | 'HIGH';

export function verificationBlocksRecall(status: string, expiresAt: Date | null, now = new Date()): boolean {
  return status === 'DISPUTED' || status === 'REFUTED' ||
    (expiresAt !== null && expiresAt.getTime() <= now.getTime());
}

/** Uses user-owned memory IDs, not guessed text, as the authority for a verification state. */
export async function markMemoryVerification(userId: string, memoryId: string, input: {
  status: VerificationStatus; volatility: Volatility; expiresAt?: string | null;
}) {
  const memory = await prisma.memoryItem.findFirst({ where: { id: memoryId, userId }, select: { id: true } });
  if (!memory) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    throw new ApiError(400, 'INVALID_DATE', '有效期无效');
  }
  const row = await prisma.memoryVerification.upsert({
    where: { memoryId },
    create: {
      userId, memoryId, status: input.status, volatility: input.volatility,
      expiresAt, reviewer: 'USER', checkedAt: new Date()
    },
    update: {
      status: input.status, volatility: input.volatility,
      expiresAt, reviewer: 'USER', checkedAt: new Date()
    }
  });
  return { memoryId, status: row.status, volatility: row.volatility, expiresAt: row.expiresAt };
}

/** Fail-closed for disputed/refuted/expired memories; absent rows preserve existing behavior. */
export async function filterVerifiedMemoryPool<T extends { id: string }>(
  userId: string, pool: readonly T[], now = new Date()
): Promise<T[]> {
  if (!pool.length) return [];
  const states = await prisma.memoryVerification.findMany({
    where: { userId, memoryId: { in: pool.map((entry) => entry.id) } },
    select: { memoryId: true, status: true, expiresAt: true }
  });
  const blocked = new Set(states.filter((state) =>
    verificationBlocksRecall(state.status, state.expiresAt, now)
  ).map((state) => state.memoryId));
  return pool.filter((item) => !blocked.has(item.id));
}
