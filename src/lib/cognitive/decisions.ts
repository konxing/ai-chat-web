import type { DecisionRecord, DecisionStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { ApiError } from '@/lib/http';
import { decryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { getCognitivePreferences } from './preferences';

/**
 * 决策记忆的读写服务层（任务书 Phase 5）。
 *
 * 密文口径和记忆一致但更严一格：AAD 里除了 userId 和 recordId 还带字段名，
 * 于是把 topic 的密文搬到 choice 列上会解不开——列和列之间也不能互换。
 *
 * 「正式决策记录」在库里的定义是 status = CONFIRMED（7.4 门槛 8）：
 * 确认动作只允许从 PENDING_CONFIRM 出发，updateMany 的 where 里带着这个状态，
 * 所以并发两次确认只有第一次命中，第二次落到 409 而不是把已确认的行再改一遍。
 */
export const DECISION_LIST_MAX_ROWS = 100;

const aadFor = (userId: string, id: string, field: string) => `decision:v1:${userId}:${id}:${field}`;

export interface DecisionDto {
  id: string;
  category: string;
  status: DecisionStatus;
  topic: string;
  choice: string;
  background: string | null;
  constraints: string | null;
  options: string | null;
  reason: string | null;
  criteria: string | null;
  expectedOutcome: string | null;
  risks: string | null;
  decidedAt: string | null;
  reviewAfter: string | null;
  confirmedAt: string | null;
  sourceMessageId: string;
  createdAt: string;
}

function toDto(row: DecisionRecord): DecisionDto {
  const plain = (field: string, ciphertext: string | null) =>
    ciphertext === null ? null : decryptString(ciphertext, aadFor(row.userId, row.id, field));
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    topic: decryptString(row.topicCiphertext, aadFor(row.userId, row.id, 'topic')),
    choice: decryptString(row.choiceCiphertext, aadFor(row.userId, row.id, 'choice')),
    background: plain('background', row.backgroundCiphertext),
    constraints: plain('constraints', row.constraintsCiphertext),
    options: plain('options', row.optionsCiphertext),
    reason: plain('reason', row.reasonCiphertext),
    criteria: plain('criteria', row.criteriaCiphertext),
    expectedOutcome: plain('expectedOutcome', row.expectedOutcomeCiphertext),
    risks: plain('risks', row.risksCiphertext),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reviewAfter: row.reviewAfter?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt.toISOString()
  };
}

/** 偏好读不出来按关闭处理，和 manager.ts 的 enabledModules 同一个口径。 */
export async function decisionModuleEnabled(userId: string): Promise<boolean> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return preferences.decisionMemoryEnabled === true;
  } catch {
    return false;
  }
}

export async function listDecisions(
  userId: string,
  options: { status?: DecisionStatus } = {}
): Promise<DecisionDto[]> {
  const rows = await prisma.decisionRecord.findMany({
    where: { userId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: DECISION_LIST_MAX_ROWS
  });
  return rows.map(toDto);
}

export type DecisionAction = 'confirm' | 'reject';

export async function setDecisionStatus(
  userId: string,
  id: string,
  action: DecisionAction
): Promise<DecisionDto> {
  const data: Prisma.DecisionRecordUpdateManyMutationInput =
    action === 'confirm'
      ? { status: 'CONFIRMED', confirmedAt: new Date() }
      : { status: 'REJECTED' };
  const updated = await prisma.decisionRecord.updateMany({
    where: { id, userId, status: 'PENDING_CONFIRM' },
    data
  });
  if (updated.count === 0) {
    const existing = await prisma.decisionRecord.findFirst({ where: { id, userId } });
    if (!existing) throw new ApiError(404, 'DECISION_NOT_FOUND', '这条决策不存在');
    throw new ApiError(409, 'DECISION_NOT_PENDING', '这条决策已经处理过了，不能再确认或拒绝');
  }
  const row = await prisma.decisionRecord.findFirst({ where: { id, userId } });
  return toDto(row!);
}
