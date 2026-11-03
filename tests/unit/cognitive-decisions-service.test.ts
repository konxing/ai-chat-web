import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@/lib/crypto';
import { listDecisions, setDecisionStatus } from '@/lib/cognitive/decisions';

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  updateCount: 0
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    decisionRecord: {
      findMany: (args: { where?: Record<string, unknown>; orderBy?: unknown; take?: number }) =>
        Promise.resolve(
          db.rows.filter((row) => {
            const where = args.where ?? {};
            return Object.entries(where).every(([key, value]) => row[key] === value);
          })
        ),
      findFirst: (args: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          db.rows.find((row) =>
            Object.entries(args.where ?? {}).every(([key, value]) => row[key] === value)
          ) ?? null
        ),
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        db.updateCalls.push(args);
        return Promise.resolve({ count: db.updateCount });
      }
    }
  }
}));

const aad = (id: string, field: string) => `decision:v1:user-a:${id}:${field}`;

function row(id: string, status: string, topic: string) {
  return {
    id,
    userId: 'user-a',
    category: 'TECH_CHOICE',
    status,
    topicCiphertext: encryptString(topic, aad(id, 'topic')),
    choiceCiphertext: encryptString(topic, aad(id, 'choice')),
    backgroundCiphertext: null,
    constraintsCiphertext: null,
    optionsCiphertext: null,
    reasonCiphertext: null,
    criteriaCiphertext: null,
    expectedOutcomeCiphertext: null,
    risksCiphertext: null,
    decidedAt: null,
    reviewAfter: null,
    confirmedAt: null,
    sourceMessageId: 'm1',
    createdAt: new Date('2026-11-04T00:00:00Z')
  };
}

describe('决策服务层', () => {
  beforeEach(() => {
    db.rows = [];
    db.updateCalls = [];
    db.updateCount = 0;
  });

  it('列表只回自己用户的行，且回到调用方的是明文不是密文', async () => {
    db.rows = [row('d1', 'PENDING_CONFIRM', '用 PostgreSQL，不上 MySQL 了')];
    const got = await listDecisions('user-a');
    expect(got).toHaveLength(1);
    expect(got[0]!.topic).toBe('用 PostgreSQL，不上 MySQL 了');
    expect(JSON.stringify(got[0])).not.toContain('Ciphertext');
  });

  it('状态过滤交给 where，不在服务层事后筛', async () => {
    db.rows = [row('d1', 'CONFIRMED', '甲'), row('d2', 'PENDING_CONFIRM', '乙')];
    const got = await listDecisions('user-a', { status: 'PENDING_CONFIRM' });
    expect(got.map((decision) => decision.id)).toEqual(['d2']);
  });

  it('确认只命中「自己 + 待确认」的行，并盖上确认时间', async () => {
    db.rows = [row('d1', 'PENDING_CONFIRM', '甲')];
    db.updateCount = 1;
    await setDecisionStatus('user-a', 'd1', 'confirm');
    const call = db.updateCalls[0]!;
    expect(call.where).toMatchObject({ id: 'd1', userId: 'user-a', status: 'PENDING_CONFIRM' });
    expect(call.data.status).toBe('CONFIRMED');
    expect(call.data.confirmedAt).toBeInstanceOf(Date);
  });

  it('拒绝不盖确认时间', async () => {
    db.rows = [row('d1', 'PENDING_CONFIRM', '甲')];
    db.updateCount = 1;
    await setDecisionStatus('user-a', 'd1', 'reject');
    const call = db.updateCalls[0]!;
    expect(call.data.status).toBe('REJECTED');
    expect(call.data).not.toHaveProperty('confirmedAt');
  });

  it('行不存在是 404，不是待确认是 409', async () => {
    db.updateCount = 0;
    await expect(setDecisionStatus('user-a', 'nope', 'confirm')).rejects.toMatchObject({
      status: 404
    });
    db.rows = [row('d1', 'CONFIRMED', '甲')];
    await expect(setDecisionStatus('user-a', 'd1', 'confirm')).rejects.toMatchObject({
      status: 409
    });
  });
});
