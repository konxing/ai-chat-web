import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@/lib/crypto';
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
  updateCount: 0
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    decisionRecord: {
      findMany: (args: { where?: Record<string, unknown> }) => {
        db.decisionFindManyWhere = args.where ?? {};
        return Promise.resolve(
          db.decisionRows.filter((row) =>
            Object.entries(args.where ?? {}).every(([key, value]) => row[key] === value)
          )
        );
      }
    },
    decisionOutcome: {
      createMany: (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
        db.outcomeCreateCalls.push(args);
        return Promise.resolve({ count: args.data.length });
      },
      findMany: (args: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          db.outcomeRows.filter((row) =>
            Object.entries(args.where ?? {}).every(([key, value]) => row[key] === value)
          )
        ),
      findFirst: (args: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          db.outcomeRows.find((row) =>
            Object.entries(args.where ?? {}).every(([key, value]) => row[key] === value)
          ) ?? null
        ),
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        db.outcomeUpdateCalls.push(args);
        return Promise.resolve({ count: db.updateCount });
      }
    }
  }
}));

const topicAad = (id: string) => `decision:v1:user-a:${id}:topic`;
const actualAad = (id: string) => `decision-outcome:v1:user-a:${id}:actual`;

describe('结果跟踪（5-D）', () => {
  beforeEach(() => {
    db.decisionRows = [];
    db.outcomeRows = [];
    db.decisionFindManyWhere = null;
    db.outcomeCreateCalls = [];
    db.outcomeUpdateCalls = [];
    db.updateCount = 0;
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
    expect(db.decisionFindManyWhere).toMatchObject({ userId: 'user-a', status: 'CONFIRMED' });
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

  it('结果列表按用户和决策过滤并解密', async () => {
    db.outcomeRows = [
      {
        id: 'o1',
        userId: 'user-a',
        decisionId: 'd1',
        linkStatus: 'CANDIDATE',
        actualCiphertext: encryptString('跑了一个月很稳', actualAad('o1')),
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
        actualCiphertext: encryptString('跑了一个月很稳', actualAad('o1')),
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
