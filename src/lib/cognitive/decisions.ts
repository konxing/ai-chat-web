import type { DecisionOutcome, DecisionRecord, DecisionStatus, OutcomeLinkStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { getCognitivePreferences } from './preferences';
import { scoreByKeyword } from './retrieval';
import type { CognitiveBlock } from './manager';
import { matchOutcomes } from './outcome-extractor';

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
const outcomeAadFor = (userId: string, id: string, field: string) =>
  `decision-outcome:v1:${userId}:${id}:${field}`;

/**
 * 反思扫描只要 topic 那一列，不该为它把九个字段都解一遍。
 * AAD 的出处仍然只有 `aadFor` 这一处，所以调用方拿不到第二份加密口径。
 */
export function decryptDecisionTopic(
  row: Pick<DecisionRecord, 'id' | 'userId' | 'topicCiphertext'>,
  viewerUserId: string
): string {
  if (row.userId !== viewerUserId) throw new ApiError(403, 'FORBIDDEN', '这条决策不属于当前用户');
  return decryptString(row.topicCiphertext, aadFor(row.userId, row.id, 'topic'));
}

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

/**
 * 结果跟踪（任务书 5.3）。后台在同一轮欠账里顺手跑：拿该用户已确认的决策做匹配，
 * 连出来的行一律 linkStatus = CANDIDATE——归因要用户在界面上点头才算数。
 * 重复投递由 (sourceMessageId, decisionId) 唯一约束挡掉。
 */
export async function writeOutcomeCandidates(input: {
  userId: string;
  content: string;
  sourceMessageId?: string;
}): Promise<void> {
  if (!input.sourceMessageId) return;
  const rows = await prisma.decisionRecord.findMany({
    where: { userId: input.userId, status: 'CONFIRMED' }
  });
  if (rows.length === 0) return;
  const matches = matchOutcomes(
    input.content,
    rows.map((row) => ({
      id: row.id,
      topic: decryptString(row.topicCiphertext, aadFor(input.userId, row.id, 'topic'))
    }))
  );
  if (matches.length === 0) return;
  const sourceMessageId = input.sourceMessageId;
  const data = matches.map((match) => {
    const id = randomUUID();
    return {
      id,
      userId: input.userId,
      decisionId: match.decisionId,
      linkStatus: 'CANDIDATE' as const,
      actualCiphertext: encryptString(match.actual, outcomeAadFor(input.userId, id, 'actual')),
      sourceMessageId
    };
  });
  await prisma.decisionOutcome.createMany({ data, skipDuplicates: true });
}

export interface OutcomeDto {
  id: string;
  decisionId: string;
  linkStatus: OutcomeLinkStatus;
  actual: string;
  gap: string | null;
  rating: string | null;
  missedFactors: string | null;
  lesson: string | null;
  sourceMessageId: string;
  recordedAt: string;
}

function toOutcomeDto(row: DecisionOutcome): OutcomeDto {
  const plain = (field: string, ciphertext: string | null) =>
    ciphertext === null ? null : decryptString(ciphertext, outcomeAadFor(row.userId, row.id, field));
  return {
    id: row.id,
    decisionId: row.decisionId,
    linkStatus: row.linkStatus,
    actual: decryptString(row.actualCiphertext, outcomeAadFor(row.userId, row.id, 'actual')),
    gap: plain('gap', row.gapCiphertext),
    rating: plain('rating', row.ratingCiphertext),
    missedFactors: plain('missedFactors', row.missedFactorsCiphertext),
    lesson: plain('lesson', row.lessonCiphertext),
    sourceMessageId: row.sourceMessageId,
    recordedAt: row.recordedAt.toISOString()
  };
}

export async function listOutcomes(userId: string, decisionId: string): Promise<OutcomeDto[]> {
  const rows = await prisma.decisionOutcome.findMany({
    where: { userId, decisionId },
    orderBy: { recordedAt: 'asc' }
  });
  return rows.map(toOutcomeDto);
}

export async function getDecisionWithOutcomes(
  userId: string,
  id: string
): Promise<{ decision: DecisionDto; outcomes: OutcomeDto[] } | null> {
  const row = await prisma.decisionRecord.findFirst({ where: { id, userId } });
  if (!row) return null;
  return { decision: toDto(row), outcomes: await listOutcomes(userId, id) };
}

export type OutcomeLinkAction = 'link' | 'detach';
/** 候选链接的确认/解除。和决策确认同构：只从 CANDIDATE 出发，where 里带着状态。 */
export async function setOutcomeLink(
  userId: string,
  decisionId: string,
  outcomeId: string,
  action: OutcomeLinkAction
): Promise<OutcomeDto> {
  const updated = await prisma.decisionOutcome.updateMany({
    where: { id: outcomeId, userId, decisionId, linkStatus: 'CANDIDATE' },
    data: { linkStatus: action === 'link' ? 'LINKED' : 'DETACHED' }
  });
  if (updated.count === 0) {
    const existing = await prisma.decisionOutcome.findFirst({ where: { id: outcomeId, userId } });
    if (!existing) throw new ApiError(404, 'OUTCOME_NOT_FOUND', '这条结果记录不存在');
    throw new ApiError(409, 'OUTCOME_NOT_CANDIDATE', '这条结果已经处理过了，不能再确认或解除');
  }
  const row = await prisma.decisionOutcome.findFirst({ where: { id: outcomeId, userId } });
  return toOutcomeDto(row!);
}

/**
 * 决策经验的读侧（任务书 5.4）。发问时把「过去相似决策」送进上下文。
 *
 * 只送已确认的决策：候选和已拒绝的都不算经验。打分复用召回那套 IDF 加权覆盖率
 * （scoreByKeyword），于是「这里连得上」和记忆召回是同一把尺子；零分一条都不送——
 * 5.4 禁止盲目复制过去的选择，送一条不相干的决策比不送更坏。
 *
 * 措辞里那句「需结合当前约束重新分析」不是装饰：它是 5.4 的禁令在提示词里的形态，
 * 模型拿到的是参考而不是指令。
 */
export const DECISION_READ_MAX_ITEMS = 2;
export const DECISION_READ_MAX_CHARS = 600;
export const DECISION_RECALL_POOL = 50;
export const DECISION_BLOCK_HEADER =
  '过去相似决策（仅供参考，需结合当前约束重新分析，不要照搬过去的选择）：';

export async function readDecisionContext(turn: {
  userId: string;
  query: string;
}): Promise<CognitiveBlock[]> {
  if (turn.query.trim() === '') return [];
  const rows = await prisma.decisionRecord.findMany({
    where: { userId: turn.userId, status: 'CONFIRMED' },
    orderBy: { createdAt: 'desc' },
    take: DECISION_RECALL_POOL
  });
  if (rows.length === 0) return [];
  const candidates = rows.map((row) => ({
    id: row.id,
    content: decryptString(row.topicCiphertext, aadFor(turn.userId, row.id, 'topic')),
    choice: decryptString(row.choiceCiphertext, aadFor(turn.userId, row.id, 'choice')),
    recordedAt: (row.decidedAt ?? row.createdAt).toISOString()
  }));
  const scored = scoreByKeyword(turn.query, candidates)
    .filter((entry) => entry.score > 0)
    .slice(0, DECISION_READ_MAX_ITEMS);
  const lines: string[] = [];
  let size = DECISION_BLOCK_HEADER.length;
  for (const entry of scored) {
    const line = `- ${entry.memory.content} → 当时选的是：${entry.memory.choice}`;
    if (size + line.length > DECISION_READ_MAX_CHARS) break;
    lines.push(line);
    size += line.length;
  }
  if (lines.length === 0) return [];
  return [{ module: 'decisionMemory', label: '决策经验', text: [DECISION_BLOCK_HEADER, ...lines].join('\n') }];
}
