import { randomUUID } from 'node:crypto';
import { encryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { extractDecisionCandidates } from './decision-extractor';
import { writeOutcomeCandidates } from './decisions';
import type { CognitiveModule, CognitiveTurn } from './manager';

/**
 * 决策记忆的写侧（任务书 Phase 5 的第一片行为）。
 *
 * 只写 PENDING_CONFIRM：7.4 门槛 8 说未经用户确认的决策不得建立为正式记录，
 * 在这里的形态就是「正式记录 = status 为 CONFIRMED 的行」，不靠任何调用方记得判。
 *
 * 挂在现有 CognitiveTask 通道上而不是新加一种任务：欠账、租约、重试、三值闸门
 * 全都白拿，decisionMemoryEnabled 本来就在 MODULE_SWITCH 表里（manager.ts），
 * 开关关掉时这条欠账会和记忆的一起作废，语义一致。
 *
 * 重复投递由库层挡：DecisionRecord 对 (sourceMessageId, category) 唯一，
 * skipDuplicates 让同一句话的同一类决策只欠一次（任务书 5.1 要求库层兜住）。
 */
const aadFor = (userId: string, id: string, field: string) => `decision:v1:${userId}:${id}:${field}`;

export async function writeDecisionCandidates(turn: CognitiveTurn): Promise<void> {
  // 门槛 3：每条持久化记录必须能追溯来源。没有消息 id 就没有来源，宁可不记。
  if (!turn.sourceMessageId) return;
  const candidates = extractDecisionCandidates(turn.content);
  if (candidates.length === 0) return;
  const sourceMessageId = turn.sourceMessageId;
  const data = candidates.map((candidate) => {
    const id = randomUUID();
    return {
      id,
      userId: turn.userId,
      category: candidate.category,
      status: 'PENDING_CONFIRM' as const,
      topicCiphertext: encryptString(candidate.topic, aadFor(turn.userId, id, 'topic')),
      choiceCiphertext: encryptString(candidate.choice, aadFor(turn.userId, id, 'choice')),
      sourceMessageId
    };
  });
  await prisma.decisionRecord.createMany({ data, skipDuplicates: true });
}

/** 读侧 5-E 才接：现在返回空块，开关开着也不会往上下文里塞任何东西。 */
export const decisionModule: CognitiveModule = {
  key: 'decisionMemory',
  read: async () => [],
  write: async (turn) => {
    await writeDecisionCandidates(turn);
    // 结果跟踪和候选抽取共用同一条欠账：一轮话里既可能做新决策，也可能在报旧决策的结果。
    await writeOutcomeCandidates(turn);
  }
};
