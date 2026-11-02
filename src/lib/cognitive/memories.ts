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

/** 一次最多捞多少行：每行都要 AES-256-GCM 解密，捞回来就是真开销，调用方不能自己放开。 */
const MEMORY_LIST_MAX_ROWS = 200;

/// 一条记忆能被信任到什么程度（任务书 2.2）。推断和假设永远不等于用户说过或确认过。
const ORIGIN_PAIRS = [
  ['explicit', 'EXPLICIT'],
  ['userConfirmed', 'USER_CONFIRMED'],
  ['observed', 'OBSERVED'],
  ['inferred', 'INFERRED'],
  ['hypothesis', 'HYPOTHESIS'],
  ['retracted', 'RETRACTED']
] as const;

/// 时间信息的精度（任务书 2.1）。用户说「16 岁」就不能存成某个具体的生日。
const PRECISION_PAIRS = [
  ['unknown', 'UNKNOWN'],
  ['year', 'YEAR'],
  ['month', 'MONTH'],
  ['day', 'DAY'],
  ['timestamp', 'TIMESTAMP']
] as const;

export type MemoryOrigin = (typeof ORIGIN_PAIRS)[number][0];
export type TimePrecision = (typeof PRECISION_PAIRS)[number][0];
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
const fromStoredOrigin = (value: string): MemoryOrigin => fromStoredEnum(ORIGIN_PAIRS, value, '记忆来源') as MemoryOrigin;
const fromStoredPrecision = (value: string): TimePrecision =>
  fromStoredEnum(PRECISION_PAIRS, value, '时间精度') as TimePrecision;

// AAD 里带上 userId 和 schemaVersion：别人的行即使密文到手也解不开，日后换密钥也能按版本迁移。
const aadFor = (userId: string, id: string) => `memory:v1:${userId}:${id}`;

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

export async function createMemory(input: MemoryInput): Promise<MemoryDto> {
  const content = validateContent(input.content);
  validateConfirmation(input.origin, input.confirmedAt);
  const precision = input.precision ?? 'unknown';
  const validFrom = input.validFrom ?? null;
  const validTo = input.validTo ?? null;
  validateTimes(precision, validFrom, validTo);

  const id = randomUUID();
  const row = await prisma.memoryItem.create({
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
      version: 1,
      supersededAt: null
    }
  });
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

/** 撤回只改来源标记，行和正文都留着——任务书要求可逆遗忘，删除是 Phase 6 的独立动作。 */
export async function markMemoryRetracted(id: string, userId: string): Promise<boolean> {
  const result = await prisma.memoryItem.updateMany({
    where: { id, userId },
    data: { origin: toStoredOrigin('retracted') }
  });
  return result.count > 0;
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
