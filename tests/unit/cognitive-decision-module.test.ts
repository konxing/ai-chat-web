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
