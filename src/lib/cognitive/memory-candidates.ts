import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';
import { exclusionHash, recordExclusions, type ExclusionSource } from './exclusions';
import { policyLearningEnabled, recordPolicySignal } from './policy-learner';
import {
  MEMORY_LIST_MAX_ROWS,
  createMemoryInTx,
  fromDbTimePrecision,
  toDbTimePrecision,
  validateMemoryContent,
  type MemoryDto,
  type TimePrecision
} from './memories';
import {
  fromDbMemoryContext,
  fromDbMemoryType,
  toDbMemoryContext,
  toDbMemoryType,
  type MemoryContext,
  type MemoryType
} from './policy';
import type { Prisma } from '@prisma/client';

/**
 * 待确认候选（任务书 1.2 的 ASK_CONFIRM，七种写入动作里的那一种）。
 *
 * 落这一片之前它是假的：`memory-module.ts` 那句
 * `if (plan.decision !== 'WRITE' && plan.decision !== 'UPDATE') continue;`
 * 把 ASK_CONFIRM 和 IGNORE 一起丢掉。用户把某个情境设成「先问再记」之后，结果既不是记住、
 * 也不是问他，而是这句话凭空消失——**用户的策略在这里是空转的**。
 *
 * 三个立场，都不是审美：
 *
 * 一、**另开一张表，不在 MemoryItem 上加 status 列。**
 * 没确认的话在现有六条读路径（对话注入、时间线、变化、网络、洞察、画像）上都不得出现；
 * 加一列就得每条读路各自记得过滤，漏一处的后果是「系统把自己的猜测当成用户说过的话带进提示词」。
 * 分开存，这类错误按结构不可能发生。
 *
 * 二、**确认之后才成为记忆，且来源是 USER_CONFIRMED 不是 EXPLICIT。**
 * 用户没有亲口说过这句话（那是抽取器从别的话里挑出来的），他是看过之后点头「这个可以记」。
 * `confirmedAt` 因此落在点确认的那一刻，不是那句话被说出的时刻——这两个时间在别的模块里
 * 也是分开的（`MemoryItem.confirmedAt` vs `recordedAt`）。
 *
 * 三、**同一句话只问一次，答过「不」就不再问。**
 * 键复用排除规则的 `exclusionHash`（HMAC(APP_SECRET, userId:归一化正文)）：
 * 「这句问过了吗」和「这句被删过吗」必须是同一个「这句」的定义，两处各算一份就会漂。
 * 库层 `@@unique([userId, contentHash])` 兜住，服务层只是把 P2002 翻成「已存在」。
 *
 * 拒绝保存同时是一条学习证据（任务书 1.3 的「用户拒绝保存」）：它和永久删除说的是同一件事——
 * 「这句话我不想要你记住」。所以 `rejectCandidate` 在同一个事务里记一条情境信号。
 *
 * 上限 200 条待确认，超了淘汰最旧的 PENDING（已确认/已拒绝的行留着，它们是答案的记录）。
 * 理由和排除表一样：这是一张隐私控件的表，但不能变成无限增长的表；而「用户从来不点」
 * 不该让待确认列表长成几百行没人看的东西。
 *
 * 测试：tests/unit/cognitive-memory-candidates.test.ts
 */

/** 待确认那一池的上限。淘汰只看 PENDING，已决断的行不受影响。 */
export const MAX_PENDING_CANDIDATES = 200;

const STATUS_PAIRS = [
  ['pending', 'PENDING'],
  ['confirmed', 'CONFIRMED'],
  ['rejected', 'REJECTED']
] as const;

export type MemoryCandidateStatus = (typeof STATUS_PAIRS)[number][0];

type DbStatus = (typeof STATUS_PAIRS)[number][1];

interface CandidateRow {
  id: string;
  userId: string;
  chatId: string | null;
  sourceMessageId: string | null;
  type: string;
  context: string;
  contentCiphertext: string;
  contentHash: string;
  status: string;
  validPrecision: string;
  validFrom: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface MemoryCandidateDto {
  id: string;
  chatId: string | null;
  sourceMessageId: string | null;
  type: MemoryType;
  context: MemoryContext;
  content: string;
  status: MemoryCandidateStatus;
  precision: TimePrecision;
  validFrom: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface MemoryCandidateInput {
  userId: string;
  type: MemoryType;
  context: MemoryContext;
  content: string;
  precision?: TimePrecision;
  validFrom?: Date | null;
  chatId?: string | null;
  sourceMessageId?: string | null;
}

export interface CandidateListFilters {
  status?: MemoryCandidateStatus;
  take?: number;
}

// 和记忆正文同一套加密口径：AAD 绑住这一行自己的 userId 和 id，别人的行解不开。
const aadFor = (userId: string, id: string) => `memory-candidate:v1:${userId}:${id}`;

function toStoredStatus(status: MemoryCandidateStatus): DbStatus {
  const match = STATUS_PAIRS.find((pair) => pair[0] === status);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', '候选状态取值不合法');
  return match[1];
}

function fromStoredStatus(value: string): MemoryCandidateStatus {
  const found = STATUS_PAIRS.find((pair) => pair[1] === value);
  if (!found) throw new ApiError(500, 'STORAGE_ERROR', '数据库里的候选状态取值异常');
  return found[0];
}

function toCandidateDto(row: CandidateRow): MemoryCandidateDto {
  let content: string;
  try {
    content = decryptString(row.contentCiphertext, aadFor(row.userId, row.id));
  } catch {
    content = '（候选内容解密失败）';
  }
  return {
    id: row.id,
    chatId: row.chatId,
    sourceMessageId: row.sourceMessageId,
    type: fromDbMemoryType(row.type),
    context: fromDbMemoryContext(row.context),
    content,
    status: fromStoredStatus(row.status),
    precision: fromDbTimePrecision(row.validPrecision),
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === 'P2002';
}

/**
 * 提一条待确认候选。返回 `created:false` 表示这句话之前已经问过或已经答过，这一次什么都不写。
 *
 * 「不重复问」靠的是库层唯一约束，不是服务层先查一遍：同一轮里两条消息可能提出同一句话，
 * 先查再写那种写法在并发下会漏。P2002 之后回读那一条，只是为了把 id 还给调用方。
 */
export async function proposeCandidate(input: MemoryCandidateInput): Promise<{ id: string; created: boolean }> {
  const content = validateMemoryContent(input.content);
  const contentHash = exclusionHash(input.userId, content);
  const id = randomUUID();
  try {
    await prisma.memoryCandidate.create({
      data: {
        id,
        userId: input.userId,
        chatId: input.chatId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        type: toDbMemoryType(input.type),
        context: toDbMemoryContext(input.context),
        contentCiphertext: encryptString(content, aadFor(input.userId, id)),
        contentHash,
        validPrecision: toDbTimePrecision(input.precision ?? 'unknown'),
        validFrom: input.validFrom ?? null
      }
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = (await prisma.memoryCandidate.findFirst({
      where: { userId: input.userId, contentHash }
    })) as unknown as CandidateRow | null;
    if (!existing) throw error;
    return { id: existing.id, created: false };
  }
  await evictOldestPending(input.userId);
  return { id, created: true };
}

/** 只淘汰还没被回答的：已确认/已拒绝的行是用户答案的记录，留着才解释得清「为什么这句不再问了」。 */
async function evictOldestPending(userId: string): Promise<void> {
  const pendingStatus = toStoredStatus('pending');
  const total = await prisma.memoryCandidate.count({ where: { userId, status: pendingStatus } });
  const excess = total - MAX_PENDING_CANDIDATES;
  if (excess <= 0) return;
  const oldest = await prisma.memoryCandidate.findMany({
    where: { userId, status: pendingStatus },
    orderBy: { createdAt: 'asc' },
    take: excess,
    select: { id: true }
  });
  if (oldest.length === 0) return;
  await prisma.memoryCandidate.deleteMany({ where: { userId, id: { in: oldest.map((row) => row.id) } } });
}

/** 某一状态的候选列表，默认只看待确认。正文逐条解密，所以行数上限沿用记忆那一份。 */
export async function listCandidates(
  userId: string,
  filters: CandidateListFilters = {}
): Promise<MemoryCandidateDto[]> {
  const rows = await prisma.memoryCandidate.findMany({
    where: { userId, status: toStoredStatus(filters.status ?? 'pending') },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filters.take ?? MEMORY_LIST_MAX_ROWS, MEMORY_LIST_MAX_ROWS)
  });
  return (rows as unknown as CandidateRow[]).map(toCandidateDto);
}

/**
 * 读一行并给出人话报错：不属于当前用户（或已经不在）是 404，已经答过是 409。
 * 这一次读只是为了让报错准确，并发安全靠的是紧随其后那条 UPDATE 自己的行锁。
 */
async function readPending(userId: string, id: string): Promise<CandidateRow> {
  const row = (await prisma.memoryCandidate.findFirst({ where: { id, userId } })) as unknown as CandidateRow | null;
  if (!row) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', '这条待确认记录不属于当前用户，或者已经不在了');
  if (row.status !== toStoredStatus('pending')) {
    throw new ApiError(409, 'CANDIDATE_DECIDED', '这条候选已经处理过了');
  }
  return row;
}

/** 抢占那一步：命中 0 行说明有人在这行读完之后抢先答了它。 */
async function claim(tx: Prisma.TransactionClient, userId: string, id: string, status: MemoryCandidateStatus, decidedAt: Date) {
  return tx.memoryCandidate.updateMany({
    where: { id, userId, status: toStoredStatus('pending') },
    data: { status: toStoredStatus(status), decidedAt }
  });
}

/**
 * 确认＝这句话现在成为记忆。两步在同一个事务里：盖候选行的戳、写记忆行（连带第一条支持证据）。
 *
 * 记忆的 `confirmedAt` 用盖戳那一刻，`recordedAt` 由 `createMemoryInTx` 自己填——
 * 两者这里是同一个时刻，但含义不同：一个是「用户确认了它」，一个是「系统记下了它」。
 */
export async function confirmCandidate(id: string, userId: string): Promise<MemoryDto> {
  const row = await readPending(userId, id);
  const content = decryptString(row.contentCiphertext, aadFor(row.userId, row.id));
  const decidedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const stamped = await claim(tx, userId, id, 'confirmed', decidedAt);
    if (stamped.count === 0) throw new ApiError(409, 'CANDIDATE_DECIDED', '这条候选已经处理过了');
    return createMemoryInTx(tx, {
      userId,
      type: fromDbMemoryType(row.type),
      context: fromDbMemoryContext(row.context),
      content,
      origin: 'userConfirmed',
      confirmedAt: decidedAt,
      precision: fromDbTimePrecision(row.validPrecision),
      validFrom: row.validFrom,
      chatId: row.chatId,
      sourceMessageId: row.sourceMessageId
    });
  });
}

/**
 * 拒绝＝这句话永远不进记忆，同时给这个情境记一条学习证据。
 *
 * 返回情境是为了让调用方（路由）在事务提交之后去跑学习：收紧策略是清理的附带效果，
 * 它失败不该把「用户已经答过不」这一事实回滚掉——口径和三条忘记链路里的 `learnAfterSignals` 一致。
 *
 * 拒绝不写来源排除行：排除规则管的是「自动抽取不要再提这句」，而这一句**已经**由候选表的
 * 唯一约束挡住了（`contentHash` 撞上 REJECTED 行就再也插不进来）。写排除行反而会把它
 * 显示进「已排除的来源」那一屏，用户撤销一条就又能问一遍——那是我们刚刚回答过「不」的话。
 */
export async function rejectCandidate(id: string, userId: string): Promise<MemoryContext> {
  // 闸门开在事务之前，和三条忘记链路同一个口径：关着学习时这一轮一条证据都不攒，
  // 事务里也就少一次写入。读不出来按关处理——认知引擎宁可什么都不学。
  const recordSignal = await policyLearningEnabled(userId);
  const row = await readPending(userId, id);
  const context = fromDbMemoryContext(row.context);
  return prisma.$transaction(async (tx) => {
    const stamped = await claim(tx, userId, id, 'rejected', new Date());
    if (stamped.count === 0) throw new ApiError(409, 'CANDIDATE_DECIDED', '这条候选已经处理过了');
    if (recordSignal) await recordPolicySignal(tx, userId, context);
    return context;
  });
}

/**
 * 三种「忘记」路径共用的清理（门槛 2：派生数据要跟着清）。
 *
 * 待确认的话既不是记忆也不是派生视图，但它同样是从用户那句话里生出来的，
 * 用户说「这个情境/这次对话/全部忘掉」之后还留着它，就等于把已经请走的东西留在门口。
 *
 * 三种范围走同一份代码，靠的是 filter 而不是三个函数——漏掉一种的后果不是少删一行，
 * 是「用户点了忘记，那句原话下一轮又被问一遍」。三种筛法各对一列：
 * `chatId` 对「忘记这次对话」，`context` 对「忘记这个主题」，
 * `contents` 对「删掉这一条记忆」：候选和记忆之间没有外键，同一句话是它们唯一的共同点，
 * 所以那一头拿被删正文去撞 `contentHash`。
 *
 * `recordExclusions` 是这一片唯一一处「删除顺带建排除」的判断，而且三个忘记路径只有两处为 true：
 * 候选行本身就是「这句不再问」的那把锁（`@@unique([userId, contentHash])`），
 * 把行删掉而不补排除，等于用户刚清完「我已经答过不的那句」，下一轮它回来重问一遍。
 * 清空全部例外——那是重新开始，不是「这些话永远别再记」，和记忆那一条同一个理由；
 * 单条删除也例外，因为同一句话的排除刚由记忆的删除记进去了，再记一次只是重复。
 *
 * 只删不落新行，也不动别的表：那三条链路各自已经处理演化边、洞察、决策和访问痕迹。
 */
export interface CandidateDeleteFilter {
  chatId?: string | null;
  context?: MemoryContext;
  /** 被删掉的记忆正文（明文）。按候选自己的归一化哈希去撞，因为那是两张表唯一的共同语言。 */
  contents?: readonly string[];
}

export async function deleteCandidatesBy(
  tx: Prisma.TransactionClient,
  userId: string,
  filter: CandidateDeleteFilter,
  options: { recordExclusions: boolean }
): Promise<number> {
  const where: Prisma.MemoryCandidateWhereInput = { userId };
  if (filter.chatId) where.chatId = filter.chatId;
  if (filter.context) where.context = toDbMemoryContext(filter.context);
  if (filter.contents) {
    const hashes = [...new Set(filter.contents.map((content) => exclusionHash(userId, content)))];
    // 一句明文都没有，就是这一轮没有任何一句话要去找它的候选：不发读也不发写。
    if (hashes.length === 0) return 0;
    where.contentHash = { in: hashes };
  }
  // 先读后删而不是直接 deleteMany：要补排除就得拿到正文，而删的范围也得和读到的那一批准确对上。
  // 按读到的 id 删还有一层意思——这一批之外的行（并发里刚插进来的那一条）不会被这一轮顺手带走。
  const rows = (await tx.memoryCandidate.findMany({ where })) as unknown as CandidateRow[];
  if (rows.length === 0) return 0;
  if (options.recordExclusions) await excludeDeletedContents(tx, userId, rows);
  const result = await tx.memoryCandidate.deleteMany({
    where: { userId, id: { in: rows.map((row) => row.id) } }
  });
  return result.count;
}

/**
 * 把被清掉的候选原话记进排除表。
 *
 * 解不开密的那一行跳过，但删除照常：和记忆那一条同一个立场——坏数据不能挡住用户的「忘记」，
 * 而日志里只有 id，没有正文（任务书 5.5）。
 */
async function excludeDeletedContents(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: readonly CandidateRow[]
): Promise<void> {
  const sources: ExclusionSource[] = [];
  for (const row of rows) {
    try {
      sources.push({
        content: decryptString(row.contentCiphertext, aadFor(userId, row.id)),
        chatId: row.chatId,
        sourceMessageId: row.sourceMessageId
      });
    } catch {
      log.warn('cognitive.candidate_exclusion_skipped', { userId, candidateId: row.id, reason: 'decrypt_failed' });
    }
  }
  if (sources.length > 0) await recordExclusions(tx, userId, sources);
}
