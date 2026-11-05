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

function row(
  id: string,
  status: string,
  topic: string,
  extra: Record<string, unknown> = {}
) {
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
    createdAt: new Date('2026-11-04T00:00:00Z'),
    ...extra
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
    const got = await listDecisions('user-a', { now: new Date('2026-11-06T00:00:00Z') });
    expect(got).toHaveLength(1);
    expect(got[0]!.topic).toBe('用 PostgreSQL，不上 MySQL 了');
    expect(JSON.stringify(got[0])).not.toContain('Ciphertext');
  });

  it('状态过滤在服务层做：派生出来的状态库里没有对应的列值', async () => {
    db.rows = [row('d1', 'CONFIRMED', '甲'), row('d2', 'PENDING_CONFIRM', '乙')];
    const got = await listDecisions('user-a', {
      now: new Date('2026-11-06T00:00:00Z'),
      status: 'PENDING_CONFIRM'
    });
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

/**
 * 「待复盘」这一桶此前是空的，而且不是「还没到时候」的空：库里没有任何一行会带
 * AWAITING_REVIEW 这个值——写侧只产 PENDING_CONFIRM，确认只写 CONFIRMED，
 * 报结果只写 OUTCOME_RECORDED。界面上那个标签是从枚举里抄来的，没有生产者。
 *
 * 修法照着洞察那一屏已经走过的路（`reflections.ts` 的 EXPIRED）：**读出来派生，不写进库**。
 * 因为「到没到复盘时间」这句话的真值每天都在变，写进库就得有个每天来改一遍的定时任务；
 * 而它一旦派生，库里那一行永远还是用户确认时的样子——被删掉、被搬走、被别的进程读到，
 * 都不会留下一个「系统替用户改过状态」的痕迹。
 */
describe('待复盘是读出来的，不是写进去的', () => {
  const now = new Date('2026-11-06T00:00:00Z');
  const past = new Date('2026-11-05T00:00:00Z');
  const future = new Date('2026-11-07T00:00:00Z');

  beforeEach(() => {
    db.rows = [];
    db.updateCalls = [];
    db.updateCount = 0;
  });

  it('过了复盘时间的已确认决策读出来是待复盘，而库里那一行仍然是 CONFIRMED', async () => {
    db.rows = [row('d1', 'CONFIRMED', '用 PostgreSQL', { reviewAfter: past })];
    const got = await listDecisions('user-a', { now });
    expect(got[0]!.status).toBe('AWAITING_REVIEW');
    expect(db.rows[0]!.status).toBe('CONFIRMED');
    expect(db.updateCalls).toHaveLength(0);
  });

  it('时间还没到就是已确认：派生只看这一次读的时刻', async () => {
    db.rows = [row('d1', 'CONFIRMED', '用 PostgreSQL', { reviewAfter: future })];
    expect((await listDecisions('user-a', { now }))[0]!.status).toBe('CONFIRMED');
  });

  it('没安排过复盘的不会凭别的原因进这一桶', async () => {
    db.rows = [row('d1', 'CONFIRMED', '用 PostgreSQL', { reviewAfter: null })];
    expect((await listDecisions('user-a', { now }))[0]!.status).toBe('CONFIRMED');
  });

  it('已经记过结果的决策不被抢回待复盘：那一桶说的是「还没回头看」', async () => {
    db.rows = [row('d1', 'OUTCOME_RECORDED', '用 PostgreSQL', { reviewAfter: past })];
    expect((await listDecisions('user-a', { now }))[0]!.status).toBe('OUTCOME_RECORDED');
  });

  it('待确认的候选不派生：还没确认的决策谈不上复盘', async () => {
    db.rows = [row('d1', 'PENDING_CONFIRM', '用 PostgreSQL', { reviewAfter: past })];
    expect((await listDecisions('user-a', { now }))[0]!.status).toBe('PENDING_CONFIRM');
  });

  it('按状态查列表查的是派生之后的状态：待复盘查得到，已确认不再重复列它', async () => {
    db.rows = [
      row('d1', 'CONFIRMED', '甲', { reviewAfter: past }),
      row('d2', 'CONFIRMED', '乙', { reviewAfter: future })
    ];
    expect(
      (await listDecisions('user-a', { now, status: 'AWAITING_REVIEW' })).map((d) => d.id)
    ).toEqual(['d1']);
    expect(
      (await listDecisions('user-a', { now, status: 'CONFIRMED' })).map((d) => d.id)
    ).toEqual(['d2']);
  });
});
