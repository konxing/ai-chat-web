import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';
import {
  fromDbMemoryContext,
  fromDbMemoryType,
  toDbMemoryContext,
  toDbMemoryType,
  type MemoryContext,
  type MemoryType
} from './policy';

export const MEMORY_CONTENT_MAX_CHARS = 1000;
export const MEMORY_REASON_MAX_CHARS = 500;

/** 一次最多捞多少行：每行都要 AES-256-GCM 解密，捞回来就是真开销，调用方不能自己放开。 */
const MEMORY_LIST_MAX_ROWS = 200;

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

function validateContent(content: string): string {
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
  const content = validateContent(input.content);
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

export async function createMemory(input: MemoryInput): Promise<MemoryDto> {
  const memory = prepareMemory(input, 1);
  const row = await prisma.memoryItem.create({ data: memory.data });
  return toDto(row as unknown as MemoryRow, input.userId);
}

export async function listMemories(userId: string, filters: MemoryListFilters = {}): Promise<MemoryDto[]> {
  const where: Record<string, unknown> = {
    userId,
    supersededAt: null,
    origin: { notIn: [toStoredOrigin('retracted')] }
  };
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

function formatDate(value: string, precision: TimePrecision): string {
  const date = new Date(value);
  const ymd = `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  if (precision === 'year') return `${date.getUTCFullYear()}年`;
  if (precision === 'month') return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`;
  if (precision !== 'timestamp') return ymd;
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${ymd} ${hh}:${mm}`;
}

/** 按精度回显有效区间，绝不显示比当初记录更精确的时间。 */
export function describeValidRange(memory: Pick<MemoryDto, 'precision' | 'validFrom' | 'validTo'>): string {
  if (memory.precision === 'unknown' || !memory.validFrom) return '时间未知';
  const from = formatDate(memory.validFrom, memory.precision);
  if (!memory.validTo) return from;
  return `${from}～${formatDate(memory.validTo, memory.precision)}`;
}
