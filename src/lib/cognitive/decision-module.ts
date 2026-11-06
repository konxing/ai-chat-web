import { randomUUID } from 'node:crypto';
import { encryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { extractDecisionCandidates } from './decision-extractor';
import { readDecisionContext, writeOutcomeCandidates } from './decisions';
import { cognitiveColumnAad } from './encrypted-columns';
import { parseReviewAfter } from './review-schedule';
import type { CognitiveModule, CognitiveTurn } from './manager';
/**
 * 决策记忆的写侧（任务书 Phase 5 的第一片行为）。
 *
 * 只写 PENDING_CONFIRM：7.4 门槛 8 说未经用户确认的决策不得建立为正式记录，
 * 在这里的形态就是「本模块只产候选，正式记录由用户在界面上确认后由 `decisions.ts` 那侧成立」，
 * 不靠任何调用方记得判。哪些状态算「用户确认过的」只有一个口径，见 `decision-status.ts`。
 *
 * 挂在现有 CognitiveTask 通道上而不是新加一种任务：欠账、租约、重试、三值闸门
 * 全都白拿，decisionMemoryEnabled 本来就在 MODULE_SWITCH 表里（manager.ts），
 * 开关关掉时这条欠账会和记忆的一起作废，语义一致。
 *
 * 重复投递由库层挡：DecisionRecord 对 (sourceMessageId, category) 唯一，
 * skipDuplicates 让同一句话的同一类决策只欠一次（任务书 5.1 要求库层兜住）。
 *
 * 5.2 的三列在这里第一次有生产者：
 * - `expectedOutcome` 只装抽取器从同一句里认领的那一分句，没说就是 null；
 * - `decidedAt` 用 `turn.occurredAt`——用户说话的那一刻，不是服务器处理到这一条的那一刻；
 *   重放历史欠账时它缺席，那就退到当下，这一列有值比 null 诚实（面板 `?? createdAt` 那条兜底
 *   从此不必再替写侧圆场）。
 * - `reviewAfter` 从**同一句**的原文算，基准就是上面那个 decidedAt；口径见 `review-schedule.ts`。
 *   剩下六列（背景/约束/可选方案/理由/标准/风险）仍然交 null：那些话不在这一句里。
 */
const aadFor = (userId: string, id: string, column: string) =>
  cognitiveColumnAad('DecisionRecord', column, userId, id);

export async function writeDecisionCandidates(turn: CognitiveTurn): Promise<void> {
  // 门槛 3：每条持久化记录必须能追溯来源。没有消息 id 就没有来源，宁可不记。
  if (!turn.sourceMessageId) return;
  const candidates = extractDecisionCandidates(turn.content);
  if (candidates.length === 0) return;
  const sourceMessageId = turn.sourceMessageId;
  const data = candidates.map((candidate) => {
    const id = randomUUID();
    const decidedAt = turn.occurredAt ?? new Date();
    return {
      id,
      userId: turn.userId,
      category: candidate.category,
      status: 'PENDING_CONFIRM' as const,
      topicCiphertext: encryptString(candidate.topic, aadFor(turn.userId, id, 'topicCiphertext')),
      choiceCiphertext: encryptString(candidate.choice, aadFor(turn.userId, id, 'choiceCiphertext')),
      expectedOutcomeCiphertext:
        candidate.expectedOutcome === null
          ? null
          : encryptString(candidate.expectedOutcome, aadFor(turn.userId, id, 'expectedOutcomeCiphertext')),
      decidedAt,
      reviewAfter: parseReviewAfter(candidate.sourceSentence, decidedAt),
      sourceMessageId
    };
  });
  await prisma.decisionRecord.createMany({ data, skipDuplicates: true });
}

/** 读侧只认「正式决策记录」那三个状态（`decision-status.ts`）：没确认过的候选一个字节都不进上下文。 */
export const decisionModule: CognitiveModule = {
  key: 'decisionMemory',
  read: (turn) => readDecisionContext({ userId: turn.userId, query: turn.content }),
  write: async (turn) => {
    await writeDecisionCandidates(turn);
    // 结果跟踪和候选抽取共用同一条欠账：一轮话里既可能做新决策，也可能在报旧决策的结果。
    await writeOutcomeCandidates(turn);
  }
};
