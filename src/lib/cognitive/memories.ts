import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';
import { recordEvidence } from './evidence';
import {
  fromDbMemoryContext,
  fromDbMemoryType,
  toDbMemoryContext,
  toDbMemoryType,
  type MemoryContext,
  type MemoryType
} from './policy';
import type { TimelineEdge } from './timeline';
import type { Prisma } from '@prisma/client';

export const MEMORY_CONTENT_MAX_CHARS = 1000;
export const MEMORY_REASON_MAX_CHARS = 500;

/** 一次最多捞多少行：每行都要 AES-256-GCM 解密，捞回来就是真开销，调用方不能自己放开。
 * 导出是给时间线用的——它和记忆列表读的是同一批行，上限必须只有一个数。 */
export const MEMORY_LIST_MAX_ROWS = 200;

/** 一条记忆能被信任到什么程度（任务书 2.2）。推断和假设永远不等于用户说过或确认过。 */
const ORIGIN_PAIRS = [
  ['explicit', 'EXPLICIT'],
  ['userConfirmed', 'USER_CONFIRMED'],
  ['observed', 'OBSERVED'],
  ['inferred', 'INFERRED'],
  ['hypothesis', 'HYPOTHESIS'],
  ['retracted', 'RETRACTED']
] as const;

/** 时间信息的精度（任务书 2.1）。用户说「16 岁」就不能存成某个具体的生日。 */
const PRECISION_PAIRS = [
  ['unknown', 'UNKNOWN'],
  ['year', 'YEAR'],
  ['month', 'MONTH'],
  ['day', 'DAY'],
  ['timestamp', 'TIMESTAMP']
] as const;

export type MemoryOrigin = (typeof ORIGIN_PAIRS)[number][0];
export type TimePrecision = (typeof PRECISION_PAIRS)[number][0];

/** 记忆被改过一次就留下一条边（任务书 2.3）。没有 CREATED：首版本行自带 sourceMessageId
 * 和 recordedAt，再记一遍只是把同一件事写两遍。 */
const REVISION_PAIRS = [
  ['superseded', 'SUPERSEDED'],
  ['retracted', 'RETRACTED']
] as const;

export type MemoryRevisionAction = (typeof REVISION_PAIRS)[number][0];
export const MEMORY_ORIGINS = ORIGIN_PAIRS.map(([app]) => app) as MemoryOrigin[];
export const TIME_PRECISIONS = PRECISION_PAIRS.map(([app]) => app) as TimePrecision[];

interface MemoryRow {
  id: string;
  userId: string;
  chatId: string | null;
  sourceMessageId: string | null;
  type: string;
  context: string;
  origin: string;
  contentCiphertext: string;
  confirmedAt: Date | null;
  version: number;
  supersededAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  validPrecision: string;
  recordedAt: Date;
}

export interface MemoryDto {
  id: string;
  chatId: string | null;
  sourceMessageId: string | null;
  type: MemoryType;
  context: MemoryContext;
  origin: MemoryOrigin;
  content: string;
  confirmedAt: string | null;
  precision: TimePrecision;
  validFrom: string | null;
  validTo: string | null;
  version: number;
  supersededAt: string | null;
  recordedAt: string;
}

export interface MemoryInput {
  userId: string;
  type: MemoryType;
  context: MemoryContext;
  content: string;
  origin: MemoryOrigin;
  confirmedAt?: Date | null;
  precision?: TimePrecision;
  validFrom?: Date | null;
  validTo?: Date | null;
  chatId?: string | null;
  sourceMessageId?: string | null;
}

export interface MemoryListFilters {
  asOf?: Date;
  types?: MemoryType[];
  contexts?: MemoryContext[];
  /** 只要最近这几条：正文是密文，捞多少行就要解密多少行，不能白搬。 */
  take?: number;
  /** 时间线要的是历史，不是「当前有效」：被新说法取代过的旧行也得进来，才能在派生层折叠。 */
  includeSuperseded?: boolean;
  /**
   * 只回归档的那几条（任务书 7.2）。默认不传＝反过来：归档行排除在外。
   * 这个入口只为「记忆」那一屏的恢复列表存在——可逆得有个看得见的地方去逆。
   */
  archivedOnly?: boolean;
}

/** 更新一条记忆（任务书 2.3）：新写一行、旧行盖 supersededAt，绝不原地改正文。
 * type/context/chatId 不传就沿用旧行——「用户换了个说法」不该顺手把情境也换了。 */
export interface MemoryReviseInput {
  previousId: string;
  userId: string;
  content: string;
  origin: MemoryOrigin;
  reason: string;
  confirmedAt?: Date | null;
  precision?: TimePrecision;
  validFrom?: Date | null;
  validTo?: Date | null;
  type?: MemoryType;
  context?: MemoryContext;
  chatId?: string | null;
  sourceMessageId?: string | null;
}

interface MemoryRevisionRow {
  id: string;
  userId: string;
  action: string;
  memoryId: string;
  previousId: string | null;
  reasonCiphertext: string;
  sourceMessageId: string | null;
  createdAt: Date;
}

export interface MemoryRevisionDto {
  id: string;
  action: MemoryRevisionAction;
  memoryId: string;
  previousId: string | null;
  reason: string;
  sourceMessageId: string | null;
  createdAt: string;
}

function toStoredEnum<K extends string, V extends string>(
  pairs: ReadonlyArray<readonly [K, V]>,
  value: K,
  field: string
): V {
  const match = pairs.find((pair) => pair[0] === value);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 取值不合法`);
  return match[1];
}

function fromStoredEnum(pairs: readonly (readonly [string, string])[], value: string, field: string): string {
  const found = pairs.find((pair) => pair[1] === value);
  if (!found) throw new ApiError(500, 'STORAGE_ERROR', `数据库里的${field}取值异常`);
  return found[0];
}

const toStoredOrigin = (origin: MemoryOrigin) => toStoredEnum(ORIGIN_PAIRS, origin, '记忆来源');
const toStoredPrecision = (precision: TimePrecision) => toStoredEnum(PRECISION_PAIRS, precision, '时间精度');
const toStoredAction = (action: MemoryRevisionAction) => toStoredEnum(REVISION_PAIRS, action, '记忆演化动作');
const fromStoredAction = (value: string): MemoryRevisionAction =>
  fromStoredEnum(REVISION_PAIRS, value, '记忆演化动作') as MemoryRevisionAction;
const fromStoredOrigin = (value: string): MemoryOrigin => fromStoredEnum(ORIGIN_PAIRS, value, '记忆来源') as MemoryOrigin;
const fromStoredPrecision = (value: string): TimePrecision =>
  fromStoredEnum(PRECISION_PAIRS, value, '时间精度') as TimePrecision;

/** 证据表和记忆表共用同一套来源枚举，映射只在这里定义一份，两边不会漂。 */
export const toDbMemoryOrigin = toStoredOrigin;
export const fromDbMemoryOrigin = fromStoredOrigin;
/** 精度也一样：派生模块（时间线、变化检测）拿到的是界面那套小写，要和数据库那套大写比时只能走这一份映射。 */
export const toDbTimePrecision = toStoredPrecision;
/** 反向那一半也走这一份：候选表存的是同一套大写枚举，确认时要读回界面那套小写。 */
export const fromDbTimePrecision = fromStoredPrecision;

// AAD 里带上 userId 和 schemaVersion：别人的行即使密文到手也解不开，日后换密钥也能按版本迁移。
const aadFor = (userId: string, id: string) => `memory:v1:${userId}:${id}`;

// 演化的理由常会复述用户那句话，所以跟正文同等对待——绑住这条边自己的 userId 和 id。
const revisionAadFor = (userId: string, id: string) => `memory-revision:v1:${userId}:${id}`;

export function decryptMemoryContent(
  memory: Pick<MemoryRow, 'id' | 'userId' | 'contentCiphertext'>,
  viewerUserId: string
): string {
  if (memory.userId !== viewerUserId) throw new ApiError(403, 'FORBIDDEN', '这条记忆不属于当前用户');
  return decryptString(memory.contentCiphertext, aadFor(memory.userId, memory.id));
}

/**
 * 记忆正文的校验。导出给待确认候选用（`memory-candidates.ts`）：
 * 「一句 1200 字的话先攒进候选表、等用户点确认时才报正文太长」是不成立的——那时用户已经答完了。
 * 所以两处共用这一份，同一句话在候选里能存下来，就必然能在记忆里落下来。
 */
export function validateMemoryContent(content: string): string {
  const text = content.trim();
  if (!text) throw new ApiError(400, 'VALIDATION_ERROR', '记忆正文不能为空');
  if (text.length > MEMORY_CONTENT_MAX_CHARS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `记忆正文不能超过 ${MEMORY_CONTENT_MAX_CHARS} 字，请拆成多条`);
  }
  return text;
}

/** 改记忆必须说得出为什么：一条没有原因的演化，事后既不能解释也不能回滚。 */
function validateReason(reason: string): string {
  const text = reason.trim();
  if (!text) throw new ApiError(400, 'VALIDATION_ERROR', '更新或撤回记忆必须写明理由');
  if (text.length > MEMORY_REASON_MAX_CHARS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `理由不能超过 ${MEMORY_REASON_MAX_CHARS} 字`);
  }
  return text;
}

function validateConfirmation(origin: MemoryOrigin, confirmedAt?: Date | null): void {
  const provenByUser = origin === 'explicit' || origin === 'userConfirmed';
  if (provenByUser && !confirmedAt) {
    throw new ApiError(400, 'VALIDATION_ERROR', '用户亲口说或确认过的记忆必须带确认时间');
  }
  if (!provenByUser && confirmedAt) {
    throw new ApiError(400, 'VALIDATION_ERROR', '只有用户亲口说或确认过的记忆才能带确认时间');
  }
}

function validateMoment(precision: TimePrecision, date: Date): void {
  const ms = date.getTime();
  const clock = ms % 86_400_000;
  if (precision === 'timestamp') return;
  if (precision === 'day' && clock === 0) return;
  if (precision === 'month' && clock === 0 && date.getUTCDate() === 1) return;
  if (precision === 'year' && clock === 0 && date.getUTCDate() === 1 && date.getUTCMonth() === 0) return;
  throw new ApiError(400, 'VALIDATION_ERROR', `时间精度是「${precision}」，有效时间不许写成更精确的日期`);
}

function validateTimes(precision: TimePrecision, validFrom: Date | null, validTo: Date | null): void {
  if (precision === 'unknown' && (validFrom || validTo)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '时间精度是「未知」时不能填写有效时间');
  }
  if (validFrom) validateMoment(precision, validFrom);
  if (validTo) validateMoment(precision, validTo);
  if (validFrom && validTo && validTo.getTime() <= validFrom.getTime()) {
    throw new ApiError(400, 'VALIDATION_ERROR', '有效结束时间必须晚于有效开始时间');
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toDto(row: MemoryRow, viewerUserId: string): MemoryDto {
  let content: string;
  try {
    content = decryptMemoryContent(row, viewerUserId);
  } catch {
    content = '（记忆解密失败）';
  }
  return {
    id: row.id,
    chatId: row.chatId,
    sourceMessageId: row.sourceMessageId,
    type: fromDbMemoryType(row.type),
    context: fromDbMemoryContext(row.context),
    origin: fromStoredOrigin(row.origin),
    content,
    confirmedAt: iso(row.confirmedAt),
    precision: fromStoredPrecision(row.validPrecision),
    validFrom: iso(row.validFrom),
    validTo: iso(row.validTo),
    version: row.version,
    supersededAt: iso(row.supersededAt),
    recordedAt: row.recordedAt.toISOString()
  };
}

/** 校验加组装待写行：新建和演化共用一份，免得两处各自放宽校验。 */
function prepareMemory(input: MemoryInput, version: number) {
  const content = validateMemoryContent(input.content);
  validateConfirmation(input.origin, input.confirmedAt);
  const precision = input.precision ?? 'unknown';
  const validFrom = input.validFrom ?? null;
  const validTo = input.validTo ?? null;
  validateTimes(precision, validFrom, validTo);

  const id = randomUUID();
  return {
    id,
    data: {
      id,
      userId: input.userId,
      chatId: input.chatId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      type: toDbMemoryType(input.type),
      context: toDbMemoryContext(input.context),
      origin: toStoredOrigin(input.origin),
      contentCiphertext: encryptString(content, aadFor(input.userId, id)),
      confirmedAt: input.confirmedAt ?? null,
      validPrecision: toStoredPrecision(precision),
      validFrom,
      validTo,
      version,
      supersededAt: null
    }
  };
}

/**
 * 在**调用方的事务里**写一条新记忆。
 *
 * 抽出来只为一件事：用户点「确认保存」时，「候选行盖戳」和「记忆行落地」必须同生共死。
 * 走 `createMemory` 会另开一个事务，中途失败就留下「候选已 CONFIRMED、记忆却没有」的半截状态，
 * 而那状态在界面上表现为「我点了确认，什么都没发生」。
 */
export async function createMemoryInTx(tx: Prisma.TransactionClient, input: MemoryInput): Promise<MemoryDto> {
  const memory = prepareMemory(input, 1);
  const row = await tx.memoryItem.create({ data: memory.data });
  // 那句话本身就是第一条支持证据。少了它，一条刚记下来的记忆在置信度上会显得毫无凭据，
  // 而「用户亲口说过一次」恰恰是它唯一也是足够的凭据。
  await recordEvidence(tx, {
    userId: input.userId,
    memoryId: memory.id,
    kind: 'supports',
    origin: input.origin,
    sourceMessageId: input.sourceMessageId ?? null,
    sourceChatId: input.chatId ?? null
  });
  return toDto(row as unknown as MemoryRow, input.userId);
}

export async function createMemory(input: MemoryInput): Promise<MemoryDto> {
  return prisma.$transaction((tx) => createMemoryInTx(tx, input));
}

export async function listMemories(userId: string, filters: MemoryListFilters = {}): Promise<MemoryDto[]> {
  const where: Record<string, unknown> = {
    userId,
    origin: { notIn: [toStoredOrigin('retracted')] },
    // 归档的这条退出「当前有效」：对话注入、时间线、写侧去重全都走这个默认口径（任务书 7.2）。
    archivedAt: null
  };
  if (filters.archivedOnly) where.archivedAt = { not: null };
  // 默认只要当前有效的那批；时间线把被取代过的旧行也读回来，但折叠不折叠是派生层的事。
  if (!filters.includeSuperseded) where.supersededAt = null;
  if (filters.types?.length) where.type = { in: filters.types.map(toDbMemoryType) };
  if (filters.contexts?.length) where.context = { in: filters.contexts.map(toDbMemoryContext) };
  if (filters.asOf) {
    where.AND = [
      { OR: [{ validTo: null }, { validTo: { gte: filters.asOf } }] },
      { OR: [{ validFrom: null }, { validFrom: { lte: filters.asOf } }] }
    ];
  }
  const rows = await prisma.memoryItem.findMany({
    where,
    orderBy: { recordedAt: 'desc' },
    take: Math.min(filters.take ?? MEMORY_LIST_MAX_ROWS, MEMORY_LIST_MAX_ROWS)
  });
  return (rows as unknown as MemoryRow[]).map((row) => toDto(row, userId));
}

export async function getMemory(id: string, userId: string): Promise<MemoryDto | null> {
  const row = await prisma.memoryItem.findFirst({ where: { id, userId } });
  return row ? toDto(row as unknown as MemoryRow, userId) : null;
}

/**
 * 更新记忆（任务书 2.3）：新写一行、给旧行盖 supersededAt、留下一条说明原因的边。
 * 旧行的正文一个字节都不改——「覆盖着写」等于把用户说过什么销毁了，也再没法回滚。
 * 三步必须在同一个事务里，否则中途失败会同时留下两条当前版本。
 */
export async function reviseMemory(input: MemoryReviseInput): Promise<MemoryDto> {
  const reason = validateReason(input.reason);
  const found = await prisma.memoryItem.findFirst({ where: { id: input.previousId, userId: input.userId } });
  if (!found) throw new ApiError(404, 'MEMORY_NOT_FOUND', '要更新的记忆不属于当前用户，或者已经不存在');
  const previous = found as unknown as MemoryRow;
  if (previous.supersededAt) {
    throw new ApiError(409, 'MEMORY_SUPERSEDED', '这条记忆已经被更新过，请对最新版本做修改');
  }

  return prisma.$transaction(async (tx) => {
    // 先抢旧行：条件里带上「还没被取代」，命中 0 行说明有人在读完之后抢先更新了。
    // 上面的 findFirst 只是给出更友好的报错，并发安全靠的是这条 UPDATE 自身的行锁。
    const stamp = await tx.memoryItem.updateMany({
      where: { id: previous.id, userId: input.userId, supersededAt: null },
      data: { supersededAt: new Date() }
    });
    if (stamp.count === 0) {
      throw new ApiError(409, 'MEMORY_SUPERSEDED', '这条记忆已经被更新过，请对最新版本做修改');
    }
    const next = prepareMemory(
      {
        userId: input.userId,
        type: input.type ?? fromDbMemoryType(previous.type),
        context: input.context ?? fromDbMemoryContext(previous.context),
        content: input.content,
        origin: input.origin,
        confirmedAt: input.confirmedAt ?? null,
        precision: input.precision,
        validFrom: input.validFrom,
        validTo: input.validTo,
        chatId: input.chatId ?? previous.chatId,
        sourceMessageId: input.sourceMessageId ?? null
      },
      previous.version + 1
    );
    const row = await tx.memoryItem.create({ data: next.data });
    const edgeId = randomUUID();
    await tx.memoryRevision.create({
      data: {
        id: edgeId,
        userId: input.userId,
        action: toStoredAction('superseded'),
        memoryId: next.id,
        previousId: previous.id,
        reasonCiphertext: encryptString(reason, revisionAadFor(input.userId, edgeId)),
        sourceMessageId: input.sourceMessageId ?? null
      }
    });
    // 新说法同时是新版本的支持证据和旧版本的反对证据（任务书 2.2 的冲突记录）。
    // 这是事实不是猜测：用户确实对同一件事说了另一件。
    // 理由不往证据里复制一份——它已经在演化边上了，两处存两份密文只是多一处不一致的可能。
    const source = {
      userId: input.userId,
      origin: input.origin,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceChatId: input.chatId ?? previous.chatId
    };
    await recordEvidence(tx, { ...source, memoryId: next.id, kind: 'supports' });
    await recordEvidence(tx, { ...source, memoryId: previous.id, kind: 'contradicts' });
    return toDto(row as unknown as MemoryRow, input.userId);
  });
}

/** 撤回只改来源标记并留一条边，行和正文都留着——关掉模块和永久删除是两个不同动作。 */
export async function retractMemory(memoryId: string, userId: string, reason: string): Promise<boolean> {
  const note = validateReason(reason);
  return prisma.$transaction(async (tx) => {
    const result = await tx.memoryItem.updateMany({
      where: { id: memoryId, userId },
      data: { origin: toStoredOrigin('retracted') }
    });
    if (result.count === 0) return false;
    const edgeId = randomUUID();
    await tx.memoryRevision.create({
      data: {
        id: edgeId,
        userId,
        action: toStoredAction('retracted'),
        memoryId,
        previousId: null,
        reasonCiphertext: encryptString(note, revisionAadFor(userId, edgeId)),
        sourceMessageId: null
      }
    });
    return true;
  });
}

/**
 * 归档（任务书 7.2 的 ARCHIVE）：只写 archivedAt 这一列。
 *
 * 和两个邻居的区别是硬的：撤回把 origin 覆写成 RETRACTED，那个原值换不回来；永久删除把行删掉。
 * 这里正文、证据、演化边、向量全留着，恢复就是清掉这一列——所以「仍可在允许范围内恢复」
 * 回到的是归档前那一条本身，而不是一条重新造出来的记忆。
 *
 * 重复归档会把时间戳推后。不为此先读一次：这一列只用来判「在不在归档态」，界面不显示它，
 * 多出来的代价是一个没人看的数。
 */
export async function archiveMemory(memoryId: string, userId: string): Promise<boolean> {
  const result = await prisma.memoryItem.updateMany({
    where: { id: memoryId, userId },
    data: { archivedAt: new Date() }
  });
  return result.count > 0;
}

/** 恢复＝把这一列清回 null，除此以外什么都不动。归档前是什么状态，恢复后还是什么状态。 */
export async function restoreMemory(memoryId: string, userId: string): Promise<boolean> {
  const result = await prisma.memoryItem.updateMany({
    where: { id: memoryId, userId },
    data: { archivedAt: null }
  });
  return result.count > 0;
}

/** 这条记忆是被谁取代的、还是被谁撤回的：按调用者自己的 userId 取，别人的边一条也不给。 */
export async function listMemoryRevisions(memoryId: string, userId: string): Promise<MemoryRevisionDto[]> {
  const rows = await prisma.memoryRevision.findMany({
    where: { memoryId, userId },
    orderBy: { createdAt: 'desc' },
    take: MEMORY_LIST_MAX_ROWS
  });
  return (rows as unknown as MemoryRevisionRow[]).map((row) => {
    let reason: string;
    try {
      reason = decryptString(row.reasonCiphertext, revisionAadFor(row.userId, row.id));
    } catch {
      reason = '（理由解密失败）';
    }
    return {
      id: row.id,
      action: fromStoredAction(row.action),
      memoryId: row.memoryId,
      previousId: row.previousId,
      reason,
      sourceMessageId: row.sourceMessageId,
      createdAt: row.createdAt.toISOString()
    };
  });
}

/**
 * 时间线要的全量演化边：只取四列，**不解密理由**。
 *
 * 逐条记忆的展开区里那份理由（listMemoryRevisions）是点开才算的，时间线一次读 200 行，
 * 为没人看的折叠把每条边的密文都解一遍只是多花一倍开销，而折叠本身只需要 previousId。
 */
export async function listRevisionEdges(userId: string): Promise<TimelineEdge[]> {
  const rows = await prisma.memoryRevision.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: MEMORY_LIST_MAX_ROWS,
    select: { memoryId: true, previousId: true, action: true, createdAt: true }
  });
  return rows.map((row) => ({
    memoryId: row.memoryId,
    previousId: row.previousId,
    action: fromStoredAction(row.action),
    createdAt: row.createdAt.toISOString()
  }));
}

/**
 * 记忆网络要的全量共引用边：同一次反思引用过的记忆，两两之间才有线。
 *
 * 读的是 `ReflectionCitation`，但放在这里而不是 `reflections.ts`：那张表只有反思那两条
 * 路由能 import（`cognitive-reflection-states.test.ts` 钉着），而图那一屏要的是
 * 「记忆和记忆被一起引用过」这层关系，它说的还是记忆之间的事。
 *
 * `memoryId` 在 schema 上可空（引用一条已被永久删除的记忆时留的是空），空值不成边，
 * 所以过滤交给数据库的 where，返回的每一行都连得上一个真实的节点。
 * `orderBy` 取的是**最近**那批：节点那侧留下的同样是最近的记忆行，按最早截会正好把
 * 连得上的边全丢掉。边在图上的先后顺序由派生层自己排，不靠读的次序。
 */
export async function listCitationEdges(userId: string): Promise<Array<{ reflectionId: string; memoryId: string }>> {
  const rows = await prisma.reflectionCitation.findMany({
    where: { userId, memoryId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: MEMORY_LIST_MAX_ROWS,
    select: { reflectionId: true, memoryId: true }
  });
  return rows.map((row) => ({ reflectionId: row.reflectionId, memoryId: row.memoryId as string }));
}

/**
 * 按 id 取记忆行的情境列。只取这两列，不解密正文。
 *
 * 画像候选的情境闸门要认的是「这条洞察引用过的那些记忆各属于什么情境」，而那些行**可能是已归档、
 * 已被取代的历史行**：`listMemories` 的默认桶把它们挡在门外，用那份列表去解析情境会把
 * 「关着门的那一路」读成「这条洞察没有引用」，于是派生品从旁边绕过了用户的排除（任务书 8.3）。
 * 这里按 id 直查，不看生命周期：解析不出来的就是解析不出来，调用方会因此不提议。
 */
export async function listMemoryContextsByIds(
  userId: string,
  memoryIds: readonly string[]
): Promise<Map<string, MemoryContext>> {
  if (memoryIds.length === 0) return new Map();
  const rows = await prisma.memoryItem.findMany({
    where: { userId, id: { in: [...memoryIds] } },
    select: { id: true, context: true },
    take: MEMORY_LIST_MAX_ROWS
  });
  return new Map(rows.map((row) => [row.id, fromDbMemoryContext(row.context)]));
}

/**
 * 把后台算好的向量写进那一行。
 *
 * 单独一步、不进写记忆那个事务：向量是一趟可选的出站调用，端点慢了或挂了
 * 都不该把已经落定的记忆带下水。`where` 带上 userId 是这条路径上唯一的隔离依据——
 * 传进来的 id 属于别人时命中 0 行，而不是去动别人的列。
 */
export async function attachMemoryVector(
  userId: string,
  memoryId: string,
  stored: { ciphertext: Buffer; model: string }
): Promise<void> {
  await prisma.memoryItem.updateMany({
    where: { id: memoryId, userId },
    data: { embeddingCiphertext: stored.ciphertext, embeddingModel: stored.model }
  });
}
