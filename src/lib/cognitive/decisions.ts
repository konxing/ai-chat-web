import type { DecisionOutcome, DecisionRecord, DecisionStatus, OutcomeLinkStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { cognitiveColumnAad } from './encrypted-columns';
import { getCognitivePreferences } from './preferences';
import { CONFIRMED_DECISION_STATUSES } from './decision-status';
import { scoreByKeyword } from './retrieval';
import type { CognitiveBlock } from './manager';
import { matchOutcomes } from './outcome-extractor';

/**
 * 决策记忆的读写服务层（任务书 Phase 5）。
 *
 * 密文口径和记忆一致但更严一格：AAD 里除了 userId 和 recordId 还带字段名，
 * 于是把 topic 的密文搬到 choice 列上会解不开——列和列之间也不能互换。
 *
 * 「正式决策记录」在库里的定义是 status ∈ CONFIRMED_DECISION_STATUSES（7.4 门槛 8）：
 * 确认动作只允许从 PENDING_CONFIRM 出发，updateMany 的 where 里带着这个状态，
 * 所以并发两次确认只有第一次命中，第二次落到 409 而不是把已确认的行再改一遍。
 *
 * 状态是一条往前走的链：CONFIRMED →（用户给这条决策报过结果并点头）OUTCOME_RECORDED。
 * 所有「已确认」的池子——召回、结果匹配、门槛 8 的计数——都得连着后面的阶段一起算，
 * 否则一条决策越有价值、报过结果之后反而越容易被悄悄筛出去。
 *
 * AWAITING_REVIEW 不在这条链上，也没有任何一处会把它写进库：它是读出来的，见 `deriveStatus`。
 */
export const DECISION_LIST_MAX_ROWS = 100;

type DecisionColumn =
  | 'topicCiphertext'
  | 'choiceCiphertext'
  | 'backgroundCiphertext'
  | 'constraintsCiphertext'
  | 'optionsCiphertext'
  | 'reasonCiphertext'
  | 'criteriaCiphertext'
  | 'expectedOutcomeCiphertext'
  | 'risksCiphertext';

type OutcomeColumn =
  | 'actualCiphertext'
  | 'gapCiphertext'
  | 'ratingCiphertext'
  | 'missedFactorsCiphertext'
  | 'lessonCiphertext';

// 列名而不是短名：调用方写错一列会撞上类型检查，不会悄悄换一把锁。
const aadFor = (userId: string, id: string, column: DecisionColumn) =>
  cognitiveColumnAad('DecisionRecord', column, userId, id);
const outcomeAadFor = (userId: string, id: string, column: OutcomeColumn) =>
  cognitiveColumnAad('DecisionOutcome', column, userId, id);

/**
 * 反思扫描只要 topic 那一列，不该为它把九个字段都解一遍。
 * AAD 的出处仍然只有 `aadFor` 这一处，所以调用方拿不到第二份加密口径。
 */
export function decryptDecisionTopic(
  row: Pick<DecisionRecord, 'id' | 'userId' | 'topicCiphertext'>,
  viewerUserId: string
): string {
  if (row.userId !== viewerUserId) throw new ApiError(403, 'FORBIDDEN', '这条决策不属于当前用户');
  return decryptString(row.topicCiphertext, aadFor(row.userId, row.id, 'topicCiphertext'));
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

function toDto(row: DecisionRecord, now: Date): DecisionDto {
  const plain = (column: DecisionColumn, ciphertext: string | null) =>
    ciphertext === null ? null : decryptString(ciphertext, aadFor(row.userId, row.id, column));
  return {
    id: row.id,
    category: row.category,
    status: deriveStatus(row, now),
    topic: decryptString(row.topicCiphertext, aadFor(row.userId, row.id, 'topicCiphertext')),
    choice: decryptString(row.choiceCiphertext, aadFor(row.userId, row.id, 'choiceCiphertext')),
    background: plain('backgroundCiphertext', row.backgroundCiphertext),
    constraints: plain('constraintsCiphertext', row.constraintsCiphertext),
    options: plain('optionsCiphertext', row.optionsCiphertext),
    reason: plain('reasonCiphertext', row.reasonCiphertext),
    criteria: plain('criteriaCiphertext', row.criteriaCiphertext),
    expectedOutcome: plain('expectedOutcomeCiphertext', row.expectedOutcomeCiphertext),
    risks: plain('risksCiphertext', row.risksCiphertext),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reviewAfter: row.reviewAfter?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * 「待复盘」是读出来的，不是写进去的（照 `reflections.ts` 的 EXPIRED 那一条路）。
 *
 * 为什么不能写进库：这一列的真值每天在变，写进库就得有一个每天把所有 CONFIRMED 行
 * 扫一遍改状态的定时任务，而那条「系统替用户改了状态」的痕迹一旦留下就擦不掉——
 * 用户撤销、删除、或者换个进程读，看到的是一个库里从来没被任何动作写过的值。
 *
 * 为什么只有 CONFIRMED 会派生：这一桶说的是「还没回头看」。已经记过结果的
 * （OUTCOME_RECORDED）回头看过了；还没确认的（PENDING_CONFIRM）谈不上复盘自己的决定。
 */
function deriveStatus(row: DecisionRecord, now: Date): DecisionStatus {
  if (row.status === 'CONFIRMED' && row.reviewAfter !== null && row.reviewAfter.getTime() <= now.getTime()) {
    return 'AWAITING_REVIEW';
  }
  return row.status;
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
  input: { now: Date; status?: DecisionStatus }
): Promise<DecisionDto[]> {
  const rows = await prisma.decisionRecord.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: DECISION_LIST_MAX_ROWS
  });
  const dtos = rows.map((row) => toDto(row, input.now));
  // 过滤发生在派生之后：AWAITING_REVIEW 没有对应的列值，交给 where 就永远查不到（口径见 `reflections.ts` 的 `state`）。
  return input.status === undefined ? dtos : dtos.filter((dto) => dto.status === input.status);
}

export type DecisionAction = 'confirm' | 'reject';

export async function setDecisionStatus(
  userId: string,
  id: string,
  action: DecisionAction
): Promise<DecisionDto> {
  const now = new Date();
  const data: Prisma.DecisionRecordUpdateManyMutationInput =
    action === 'confirm' ? { status: 'CONFIRMED', confirmedAt: now } : { status: 'REJECTED' };
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
  // 刚确认的这一行若安排了复盘而且日子已过，回给界面的就是待复盘：和列表读出来的是同一个派生，
  // 两处不该各判一次。
  return toDto(row!, now);
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
    where: { userId: input.userId, status: { in: [...CONFIRMED_DECISION_STATUSES] } }
  });
  if (rows.length === 0) return;
  const matches = matchOutcomes(
    input.content,
    rows.map((row) => ({
      id: row.id,
      topic: decryptString(row.topicCiphertext, aadFor(input.userId, row.id, 'topicCiphertext'))
    }))
  );
  if (matches.length === 0) return;
  const sourceMessageId = input.sourceMessageId;
  const data = matches.map((match) => {
    const id = randomUUID();
    // 派生不出来的分面写 null，不写空串：空串在界面上是一行「有内容但没字」，
    // null 才是「这句没说过」。每列一把封口，把 rating 的密文搬到 actual 列上解不开。
    const facet = (
      column: 'gapCiphertext' | 'ratingCiphertext' | 'missedFactorsCiphertext' | 'lessonCiphertext',
      value: string | null
    ) => (value === null ? null : encryptString(value, outcomeAadFor(input.userId, id, column)));
    return {
      id,
      userId: input.userId,
      decisionId: match.decisionId,
      linkStatus: 'CANDIDATE' as const,
      actualCiphertext: encryptString(match.actual, outcomeAadFor(input.userId, id, 'actualCiphertext')),
      gapCiphertext: facet('gapCiphertext', match.gap),
      ratingCiphertext: facet('ratingCiphertext', match.rating),
      missedFactorsCiphertext: facet('missedFactorsCiphertext', match.missedFactors),
      lessonCiphertext: facet('lessonCiphertext', match.lesson),
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
  const plain = (column: OutcomeColumn, ciphertext: string | null) =>
    ciphertext === null ? null : decryptString(ciphertext, outcomeAadFor(row.userId, row.id, column));
  return {
    id: row.id,
    decisionId: row.decisionId,
    linkStatus: row.linkStatus,
    actual: decryptString(row.actualCiphertext, outcomeAadFor(row.userId, row.id, 'actualCiphertext')),
    gap: plain('gapCiphertext', row.gapCiphertext),
    rating: plain('ratingCiphertext', row.ratingCiphertext),
    missedFactors: plain('missedFactorsCiphertext', row.missedFactorsCiphertext),
    lesson: plain('lessonCiphertext', row.lessonCiphertext),
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
  return { decision: toDto(row, new Date()), outcomes: await listOutcomes(userId, id) };
}

export type OutcomeLinkAction = 'link' | 'detach';
/**
 * 候选链接的确认/解除。和决策确认同构：只从 CANDIDATE 出发，where 里带着状态。
 *
 * 点头（link）同时把那条决策推到 OUTCOME_RECORDED——这一步是 6.1 DECISION_LESSON 唯一的依据，
 * 库里此前没有任何一处写过这个状态，那条反思类型因此永远出不来。推的时候 where 带着
 * `status: CONFIRMED`，所以并发和重复投递都只命中一次，推不动也不报错：决策行可能已被删，
 * 那是另一条记录的事，不该把用户刚点下去的这次确认整体失败。
 *
 * 解除（detach）不回退状态。用户否认的是「这句话算不算这条决策的结果」这次归因，
 * 不是「我没提过结果」——实际结果那一列还留在库里。
 */
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
  if (action === 'link') {
    await prisma.decisionRecord.updateMany({
      where: { id: decisionId, userId, status: 'CONFIRMED' },
      data: { status: 'OUTCOME_RECORDED' }
    });
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
    where: { userId: turn.userId, status: { in: [...CONFIRMED_DECISION_STATUSES] } },
    orderBy: { createdAt: 'desc' },
    take: DECISION_RECALL_POOL
  });
  if (rows.length === 0) return [];
  const candidates = rows.map((row) => ({
    id: row.id,
    content: decryptString(row.topicCiphertext, aadFor(turn.userId, row.id, 'topicCiphertext')),
    choice: decryptString(row.choiceCiphertext, aadFor(turn.userId, row.id, 'choiceCiphertext')),
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
