import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString } from '@/lib/crypto';
import {
  listOutcomes,
  setOutcomeLink,
  writeOutcomeCandidates
} from '@/lib/cognitive/decisions';

const db = vi.hoisted(() => ({
  decisionRows: [] as Array<Record<string, unknown>>,
  outcomeRows: [] as Array<Record<string, unknown>>,
  decisionFindManyWhere: null as Record<string, unknown> | null,
  outcomeCreateCalls: [] as Array<{ where?: unknown; data: Array<Record<string, unknown>> }>,
  outcomeUpdateCalls: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  decisionUpdateCalls: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  updateCount: 0,
  decisionUpdateCount: 0
}));

/** 只认这里用到的两种条件：等值和 `{ in: [...] }`。 */
const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([key, value]) =>
    value !== null && typeof value === 'object' && 'in' in value
      ? (value as { in: readonly unknown[] }).in.includes(row[key])
      : row[key] === value
  );

vi.mock('@/lib/prisma', () => ({
  prisma: {
    decisionRecord: {
      findMany: (args: { where?: Record<string, unknown> }) => {
        db.decisionFindManyWhere = args.where ?? {};
        return Promise.resolve(db.decisionRows.filter((row) => matches(row, args.where ?? {})));
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        db.decisionUpdateCalls.push(args);
        return Promise.resolve({ count: db.decisionUpdateCount });
      }
    },
    decisionOutcome: {
      createMany: (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
        db.outcomeCreateCalls.push(args);
        return Promise.resolve({ count: args.data.length });
      },
      findMany: (args: { where?: Record<string, unknown> }) =>
        Promise.resolve(db.outcomeRows.filter((row) => matches(row, args.where ?? {}))),
      findFirst: (args: { where?: Record<string, unknown> }) =>
        Promise.resolve(db.outcomeRows.find((row) => matches(row, args.where ?? {})) ?? null),
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        db.outcomeUpdateCalls.push(args);
        return Promise.resolve({ count: db.updateCount });
      }
    }
  }
}));

const topicAad = (id: string) => `decision:v1:user-a:${id}:topic`;
const outcomeAad = (id: string, field: string) => `decision-outcome:v1:user-a:${id}:${field}`;

describe('结果跟踪（5-D）', () => {
  beforeEach(() => {
    db.decisionRows = [];
    db.outcomeRows = [];
    db.decisionFindManyWhere = null;
    db.outcomeCreateCalls = [];
    db.outcomeUpdateCalls = [];
    db.decisionUpdateCalls = [];
    db.updateCount = 0;
    db.decisionUpdateCount = 0;
  });

  it('只拿已确认的决策做匹配，连出来的是 CANDIDATE', async () => {
    db.decisionRows = [
      {
        id: 'd1',
        userId: 'user-a',
        status: 'CONFIRMED',
        topicCiphertext: encryptString('用 PostgreSQL，不上 MySQL 了', topicAad('d1'))
      },
      {
        id: 'd2',
        userId: 'user-a',
        status: 'PENDING_CONFIRM',
        topicCiphertext: encryptString('用 PostgreSQL，不上 MySQL 了', topicAad('d2'))
      }
    ];
    await writeOutcomeCandidates({
      userId: 'user-a',
      content: '结果 PostgreSQL 跑了一个月，比想象中稳。',
      sourceMessageId: 'm9'
    });
    const pool = (db.decisionFindManyWhere ?? {}).status as { in: readonly string[] };
    expect(db.decisionFindManyWhere).toMatchObject({ userId: 'user-a' });
    expect(pool.in).toEqual(expect.arrayContaining(['CONFIRMED', 'AWAITING_REVIEW', 'OUTCOME_RECORDED']));
    expect(pool.in).not.toContain('PENDING_CONFIRM');
    expect(pool.in).not.toContain('REJECTED');
    expect(db.outcomeCreateCalls).toHaveLength(1);
    const row = db.outcomeCreateCalls[0]!.data[0]!;
    expect(row.linkStatus).toBe('CANDIDATE');
    expect(row.decisionId).toBe('d1');
    expect(row.sourceMessageId).toBe('m9');
    expect(row.userId).toBe('user-a');
    expect(row.actualCiphertext).not.toBe('结果 PostgreSQL 跑了一个月，比想象中稳');
  });

  it('没有来源消息 id 或没有匹配时不写', async () => {
    db.decisionRows = [
      {
        id: 'd1',
        userId: 'user-a',
        status: 'CONFIRMED',
        topicCiphertext: encryptString('用 PostgreSQL，不上 MySQL 了', topicAad('d1'))
      }
    ];
    await writeOutcomeCandidates({ userId: 'user-a', content: '结果 PostgreSQL 很稳。' });
    await writeOutcomeCandidates({
      userId: 'user-a',
      content: '结果今天下雨了。',
      sourceMessageId: 'm9'
    });
    expect(db.outcomeCreateCalls).toHaveLength(0);
  });

  it('四个分面各按自己那一列加密：派生不出的写 null，搬列就解不开', async () => {
    db.decisionRows = [
      {
        id: 'd1',
        userId: 'user-a',
        status: 'CONFIRMED',
        topicCiphertext: encryptString('用 PostgreSQL，不上 MySQL 了', topicAad('d1'))
      }
    ];
    await writeOutcomeCandidates({
      userId: 'user-a',
      content: '结果 PostgreSQL 很稳，真香，没想到备份这么麻烦，下次一定先估运维。',
      sourceMessageId: 'm9'
    });
    const row = db.outcomeCreateCalls[0]!.data[0]!;
    const id = row.id as string;

    expect(decryptString(row.actualCiphertext as string, outcomeAad(id, 'actual'))).toBe(
      '结果 PostgreSQL 很稳，真香，没想到备份这么麻烦，下次一定先估运维'
    );
    expect(decryptString(row.ratingCiphertext as string, outcomeAad(id, 'rating'))).toBe('真香');
    expect(decryptString(row.missedFactorsCiphertext as string, outcomeAad(id, 'missedFactors'))).toBe(
      '没想到备份这么麻烦'
    );
    expect(decryptString(row.lessonCiphertext as string, outcomeAad(id, 'lesson'))).toBe('下次一定先估运维');
    // 这句里没有「预期差异」的说法——派生不出就留 null，不拿别的话凑那一列。
    expect(row.gapCiphertext).toBeNull();
    // 每列一把封口：把 rating 那串搬到 actual 上解不开。
    expect(() => decryptString(row.ratingCiphertext as string, outcomeAad(id, 'actual'))).toThrow();
  });

  it('结果列表按用户和决策过滤并解密', async () => {
    db.outcomeRows = [
      {
        id: 'o1',
        userId: 'user-a',
        decisionId: 'd1',
        linkStatus: 'CANDIDATE',
        actualCiphertext: encryptString('跑了一个月很稳', outcomeAad('o1', 'actual')),
        gapCiphertext: null,
        ratingCiphertext: null,
        missedFactorsCiphertext: null,
        lessonCiphertext: null,
        sourceMessageId: 'm9',
        recordedAt: new Date('2026-11-04T00:00:00Z')
      }
    ];
    const got = await listOutcomes('user-a', 'd1');
    expect(got).toHaveLength(1);
    expect(got[0]!.actual).toBe('跑了一个月很稳');
    expect(JSON.stringify(got[0])).not.toContain('Ciphertext');
  });

  it('确认/解除链接只从 CANDIDATE 出发', async () => {
    db.outcomeRows = [
      {
        id: 'o1',
        userId: 'user-a',
        decisionId: 'd1',
        linkStatus: 'CANDIDATE',
        actualCiphertext: encryptString('跑了一个月很稳', outcomeAad('o1', 'actual')),
        gapCiphertext: null,
        ratingCiphertext: null,
        missedFactorsCiphertext: null,
        lessonCiphertext: null,
        sourceMessageId: 'm9',
        recordedAt: new Date('2026-11-04T00:00:00Z')
      }
    ];
    db.updateCount = 1;
    await setOutcomeLink('user-a', 'd1', 'o1', 'link');
    expect(db.outcomeUpdateCalls[0]!.where).toMatchObject({
      id: 'o1',
      userId: 'user-a',
      decisionId: 'd1',
      linkStatus: 'CANDIDATE'
    });
    expect(db.outcomeUpdateCalls[0]!.data.linkStatus).toBe('LINKED');
    await setOutcomeLink('user-a', 'd1', 'o1', 'detach');
    expect(db.outcomeUpdateCalls[1]!.data.linkStatus).toBe('DETACHED');
  });

  it('确认关联把决策推成 OUTCOME_RECORDED——不然 DECISION_LESSON 永远没有依据', async () => {
    db.decisionRows = [
      {
        id: 'd1',
        userId: 'user-a',
        status: 'CONFIRMED',
        topicCiphertext: encryptString('用 PostgreSQL，不上 MySQL 了', topicAad('d1'))
      }
    ];
    db.outcomeRows = [
      {
        id: 'o1',
        userId: 'user-a',
        decisionId: 'd1',
        linkStatus: 'CANDIDATE',
        actualCiphertext: encryptString('跑了一个月很稳', outcomeAad('o1', 'actual')),
        gapCiphertext: null,
        ratingCiphertext: null,
        missedFactorsCiphertext: null,
        lessonCiphertext: null,
        sourceMessageId: 'm9',
        recordedAt: new Date('2026-11-04T00:00:00Z')
      }
    ];
    db.updateCount = 1;
    db.decisionUpdateCount = 1;
    await setOutcomeLink('user-a', 'd1', 'o1', 'link');
    expect(db.decisionUpdateCalls).toHaveLength(1);
    expect(db.decisionUpdateCalls[0]!.where).toMatchObject({
      id: 'd1',
      userId: 'user-a',
      status: 'CONFIRMED'
    });
    expect(db.decisionUpdateCalls[0]!.data).toEqual({ status: 'OUTCOME_RECORDED' });
  });

  it('解除归因不回退决策状态：用户否认的是归因，不是「没提过结果」', async () => {
    db.outcomeRows = [
      {
        id: 'o1',
        userId: 'user-a',
        decisionId: 'd1',
        linkStatus: 'CANDIDATE',
        actualCiphertext: encryptString('跑了一个月很稳', outcomeAad('o1', 'actual')),
        gapCiphertext: null,
        ratingCiphertext: null,
        missedFactorsCiphertext: null,
        lessonCiphertext: null,
        sourceMessageId: 'm9',
        recordedAt: new Date('2026-11-04T00:00:00Z')
      }
    ];
    db.updateCount = 1;
    await setOutcomeLink('user-a', 'd1', 'o1', 'detach');
    expect(db.decisionUpdateCalls).toHaveLength(0);
  });

  it('决策行推不动（已被删）不拦结果链接本身：那是另一条记录的事', async () => {
    db.outcomeRows = [
      {
        id: 'o1',
        userId: 'user-a',
        decisionId: 'd1',
        linkStatus: 'CANDIDATE',
        actualCiphertext: encryptString('跑了一个月很稳', outcomeAad('o1', 'actual')),
        gapCiphertext: null,
        ratingCiphertext: null,
        missedFactorsCiphertext: null,
        lessonCiphertext: null,
        sourceMessageId: 'm9',
        recordedAt: new Date('2026-11-04T00:00:00Z')
      }
    ];
    db.decisionRows = [];
    db.updateCount = 1;
    db.decisionUpdateCount = 0;
    await expect(setOutcomeLink('user-a', 'd1', 'o1', 'link')).resolves.toBeDefined();
  });

  it('已记录结果、待复盘的决策仍然接着报结果', async () => {
    db.decisionRows = [
      {
        id: 'd9',
        userId: 'user-a',
        status: 'OUTCOME_RECORDED',
        topicCiphertext: encryptString('用 PostgreSQL，不上 MySQL 了', topicAad('d9'))
      }
    ];
    await writeOutcomeCandidates({
      userId: 'user-a',
      content: '结果 PostgreSQL 后来踩了个大坑。',
      sourceMessageId: 'm10'
    });
    expect(db.outcomeCreateCalls).toHaveLength(1);
    expect(db.outcomeCreateCalls[0]!.data[0]!.decisionId).toBe('d9');
  });

  it('行不存在 404，不是候选 409', async () => {
    db.updateCount = 0;
    await expect(setOutcomeLink('user-a', 'd1', 'nope', 'link')).rejects.toMatchObject({
      status: 404
    });
    db.outcomeRows = [{ id: 'o1', userId: 'user-a', decisionId: 'd1', linkStatus: 'LINKED' }];
    await expect(setOutcomeLink('user-a', 'd1', 'o1', 'link')).rejects.toMatchObject({
      status: 409
    });
  });
});
