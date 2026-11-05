import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString } from '@/lib/crypto';
import { writeDecisionCandidates } from '@/lib/cognitive/decision-module';

const prisma = vi.hoisted(() => ({
  decisionRecord: { createMany: vi.fn() }
}));

vi.mock('@/lib/prisma', () => ({ prisma }));

/**
 * 5-B 的写侧契约：只写 PENDING_CONFIRM（7.4 门槛 8 的库里形态），
 * 内容列是密文且 AAD 绑到字段名，来源消息缺失时一条都不写（门槛 3）。
 */
describe('决策候选写侧', () => {
  beforeEach(() => {
    prisma.decisionRecord.createMany.mockReset();
    prisma.decisionRecord.createMany.mockResolvedValue({ count: 1 });
  });

  const turn = {
    userId: 'u1',
    chatId: 'c1',
    content: '我决定用 PostgreSQL，不上 MySQL 了。',
    sourceMessageId: 'm1'
  };

  it('只写 PENDING_CONFIRM，主题与选择是密文且能按字段名解回', async () => {
    await writeDecisionCandidates(turn);
    expect(prisma.decisionRecord.createMany).toHaveBeenCalledTimes(1);
    const call = prisma.decisionRecord.createMany.mock.calls[0]![0];
    expect(call.skipDuplicates).toBe(true);
    const row = call.data[0];
    expect(row.status).toBe('PENDING_CONFIRM');
    expect(row.category).toBe('TECH_CHOICE');
    expect(row.sourceMessageId).toBe('m1');
    expect(row.userId).toBe('u1');
    const aad = `decision:v1:u1:${row.id}:topic`;
    expect(decryptString(row.topicCiphertext, aad)).toBe('用 PostgreSQL，不上 MySQL 了');
    expect(decryptString(row.choiceCiphertext, `decision:v1:u1:${row.id}:choice`)).toBe(
      '用 PostgreSQL，不上 MySQL 了'
    );
  });

  it('没有来源消息 id 时一条都不写', async () => {
    await writeDecisionCandidates({ userId: 'u1', chatId: 'c1', content: turn.content });
    expect(prisma.decisionRecord.createMany).not.toHaveBeenCalled();
  });

  it('抽不出候选时不碰库', async () => {
    await writeDecisionCandidates({ ...turn, content: '今天天气不错。' });
    expect(prisma.decisionRecord.createMany).not.toHaveBeenCalled();
  });
});

/**
 * 任务书 5.2 里的「预期结果」「决策时间」「可选的后续复盘时间」三列此前一个生产者都没有：
 * 列建好了、面板也留着位置，写侧却永远交 null，于是面板上「永远不会有数据」不是实现进度问题，
 * 是这条路根本没接。这组用例钉的是这三列第一次真的从同一句话里拿到值。
 */
describe('决策候选写侧：预期结果 / 决策时间 / 复盘时间', () => {
  beforeEach(() => {
    prisma.decisionRecord.createMany.mockReset();
    prisma.decisionRecord.createMany.mockResolvedValue({ count: 1 });
  });

  const occurredAt = new Date('2026-11-06T04:00:00Z');

  const write = async (content: string) => {
    await writeDecisionCandidates({
      userId: 'u1',
      chatId: 'c1',
      content,
      sourceMessageId: 'm1',
      occurredAt
    });
    return prisma.decisionRecord.createMany.mock.calls[0]![0].data[0];
  };

  it('同一句里的预期分句落进 expectedOutcome 列，封口绑到这一个字段名', async () => {
    const row = await write('我决定用 PostgreSQL，预计查询能快一倍。');
    expect(decryptString(row.expectedOutcomeCiphertext, `decision:v1:u1:${row.id}:expectedOutcome`)).toBe(
      '预计查询能快一倍'
    );
    // 预期那句不许同时留在「用户选择」里显示第二遍。
    expect(decryptString(row.choiceCiphertext, `decision:v1:u1:${row.id}:choice`)).toBe('用 PostgreSQL');
  });

  it('用户没说预期就是 null：这一列不从「我决定」里推断出一个预期', async () => {
    const row = await write('我打算学 Rust，每周投入十小时。');
    expect(row.expectedOutcomeCiphertext).toBeNull();
  });

  it('复盘时间从决策那一刻起算，按定长月换算成天数', async () => {
    const row = await write('我决定用 PostgreSQL，预计三个月后再看一次。');
    expect(row.expectedOutcomeCiphertext).toBeNull();
    expect(row.reviewAfter.getTime()).toBe(occurredAt.getTime() + 90 * 86_400_000);
  });

  it('话里没安排复盘就留 null，不许替他挑一个默认周期', async () => {
    const row = await write('我决定用 PostgreSQL，不上 MySQL 了。');
    expect(row.reviewAfter).toBeNull();
  });

  it('决策时间取用户说话的那一刻，不是服务器处理到这一条的那一刻', async () => {
    const row = await write('我决定用 PostgreSQL，不上 MySQL 了。');
    expect(row.decidedAt).toEqual(occurredAt);
  });

  it('历史欠账重放没有 occurredAt 时也要有决策时间，不能落 null', async () => {
    await writeDecisionCandidates({
      userId: 'u1',
      chatId: 'c1',
      content: '我决定用 PostgreSQL，不上 MySQL 了。',
      sourceMessageId: 'm1'
    });
    const row = prisma.decisionRecord.createMany.mock.calls[0]![0].data[0];
    expect(row.decidedAt instanceof Date).toBe(true);
    expect(row.reviewAfter).toBeNull();
  });
});
