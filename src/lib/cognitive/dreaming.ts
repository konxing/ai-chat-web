import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { consolidationEnabled } from './cognitive-flags';
import { getCognitivePreferences } from './preferences';
import { runSessionSummarySweep } from './memory-session-summary';

export const DREAMING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DREAMING_LEASE_MS = 120_000;
const HIGH_VOLATILITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MEDIUM_VOLATILITY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * One durable lease per user. No prompts may rewrite verified personal notes.
 * This job only invalidates clearly stale verification metadata, and reuses the
 * separately gated session summary. It never edits the original transcript.
 */
export async function runDreamingSweep(userId: string): Promise<{ ran: boolean; invalidated: number }> {
  if (!(await consolidationEnabled())) return { ran: false, invalidated: 0 };
  const pref = await getCognitivePreferences(userId);
  if (!pref.memoryEnabled || pref.memoryWritePaused) return { ran: false, invalidated: 0 };
  const now = new Date();
  await prisma.dreamingRun.upsert({
    where: { userId },
    create: { userId },
    update: {}
  });
  const token = randomUUID();
  const claimed = await prisma.dreamingRun.updateMany({
    where: {
      userId, nextRunAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
    },
    data: {
      leaseToken: token,
      leaseUntil: new Date(now.getTime() + DREAMING_LEASE_MS)
    }
  });
  if (!claimed.count) return { ran: false, invalidated: 0 };
  let invalidated = 0;
  let failed = false;
  try {
    const candidates = await prisma.memoryVerification.findMany({
      where: {
        userId, status: 'VERIFIED',
        OR: [
          { volatility: 'HIGH', checkedAt: { lte: new Date(now.getTime() - HIGH_VOLATILITY_MAX_AGE_MS) } },
          { volatility: 'MEDIUM', checkedAt: { lte: new Date(now.getTime() - MEDIUM_VOLATILITY_MAX_AGE_MS) } }
        ]
      },
      orderBy: { checkedAt: 'asc' },
      take: 32,
      select: { id: true, checkedAt: true }
    });
    for (const candidate of candidates) {
      const result = await prisma.memoryVerification.updateMany({
        where: {
          id: candidate.id, userId, status: 'VERIFIED', checkedAt: candidate.checkedAt
        },
        data: {
          status: 'UNVERIFIED', expiresAt: now, reviewer: 'DREAMING'
        }
      });
      invalidated += result.count;
    }
    // The summary feature has its own administrator gate, memory preference
    // gate and idle threshold. No extra model calls when disabled.
    await runSessionSummarySweep(userId);
  } catch {
    failed = true;
    log.warn('cognitive.dreaming_failed', { userId, reason: 'sweep_failed' });
  } finally {
    await prisma.dreamingRun.updateMany({
      where: { userId, leaseToken: token },
      data: {
        leaseToken: null, leaseUntil: null,
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + (failed ? 30 * 60_000 : DREAMING_INTERVAL_MS)),
        checkedCount: { increment: invalidated }
      }
    });
  }
  return { ran: true, invalidated };
}

/** Small idle-time schedule: one user per 10 min, round-robin across all enabled users. */
let lastPoll = 0;
let cursor = 0;
export async function pollIdleDreaming(): Promise<void> {
  const now = Date.now();
  if (now - lastPoll < 10 * 60_000) return;
  lastPoll = now;
  if (!(await consolidationEnabled())) return;
  const count = await prisma.cognitivePreference.count({ where: { memoryEnabled: true } });
  if (!count) return;
  const rows = await prisma.cognitivePreference.findMany({
    where: { memoryEnabled: true }, orderBy: { userId: 'asc' },
    skip: cursor % count, take: 1, select: { userId: true }
  });
  cursor += 1;
  if (rows[0]) await runDreamingSweep(rows[0].userId);
}
