import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import type { CognitiveAadCoord } from './aad';
import { decryptCognitiveString, encryptCognitiveString } from './aad';
import { cognitiveColumnCoord } from './encrypted-columns';
import { assessConfidence, type Confidence } from './confidence';
import { fromDbMemoryOrigin, toDbMemoryOrigin, type MemoryOrigin } from './memories';
import type { Prisma } from '@prisma/client';

/**
 * 认知证据账本（任务书 2.2）。
 *
 * 一条证据只回答「这条记忆凭什么在这里」，不改变它的内容。
 * 置信度不存在记忆行上，而是读时按这些证据算出来——存一列就要维护刷新时机，
 * 漏一处就是一个过期的假数字。
 *
 * 说明文字（用户更正时写的理由这类）和记忆正文同等对待：AES-256-GCM，
 * AAD 绑住 userId 和这条证据自己的 id。
 *
 * 这里和 memories.ts 之间是一个**刻意的循环引用**：memories 要在同一个事务里
 * 既写记忆行又写证据（少一半就是错的），所以它必须引 recordEvidence；
 * 而证据行要存来源枚举，映射只该有一份，所以这里反过来引 toDbMemoryOrigin。
 * 两边都只在函数体里用对方的绑定，模块顶层不碰，ESM 的循环求值就是安全的。
 * **不要在这两个文件的顶层加任何用到对方导出的代码**，那会踩到 TDZ。
 *
 * 测试：tests/unit/cognitive-evidence.test.ts
 */

const KIND_PAIRS = [
  ['supports', 'SUPPORTS'],
  ['contradicts', 'CONTRADICTS']
] as const;

export type EvidenceKind = (typeof KIND_PAIRS)[number][0];

type DbEvidenceKind = (typeof KIND_PAIRS)[number][1];

export interface EvidenceInput {
  userId: string;
  memoryId: string;
  kind: EvidenceKind;
  origin: MemoryOrigin;
  sourceMessageId?: string | null;
  sourceChatId?: string | null;
  note?: string | null;
}

export interface EvidenceDto {
  id: string;
  kind: EvidenceKind;
  origin: MemoryOrigin;
  sourceMessageId: string | null;
  sourceChatId: string | null;
  note: string | null;
  createdAt: string;
}

/** 算置信度需要的字段。刻意不依赖 MemoryDto：证据层不该知道记忆对外的完整形状。 */
export interface ConfidenceSubject {
  id: string;
  origin: MemoryOrigin;
  confirmedAt: string | null;
  supersededAt: string | null;
  validTo: string | null;
}

/** 一条记忆各自的证据条数。置信度只数这个，不数被检索到了几次。 */
export interface EvidenceCounts {
  supports: number;
  contradicts: number;
}

interface EvidenceRow {
  id: string;
  userId: string;
  memoryId: string;
  kind: string;
  origin: string;
  sourceMessageId: string | null;
  sourceChatId: string | null;
  noteCiphertext: string | null;
  createdAt: Date;
}

// 证据的说明常会复述那句话，所以跟正文同等对待。封口走 aad.ts 那一份四坐标口径。
const noteAad = (userId: string, id: string): CognitiveAadCoord =>
  cognitiveColumnCoord('MemoryEvidence', 'noteCiphertext', userId, id);

function toDbKind(kind: EvidenceKind): DbEvidenceKind {
  const match = KIND_PAIRS.find((pair) => pair[0] === kind);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', '证据方向只能是 supports 或 contradicts');
  return match[1];
}

function fromDbKind(value: string): EvidenceKind {
  const match = KIND_PAIRS.find((pair) => pair[1] === value);
  if (!match) throw new ApiError(500, 'STORAGE_ERROR', '数据库里的证据方向取值异常');
  return match[0];
}

/**
 * 记一条证据。跟着调用方的事务走：记忆写进去了而证据没记上，
 * 这条记忆的可信度就永远少算一次，而且没人看得出来。
 *
 * 同一条消息对同一条记忆同一个方向只算一次——重复计分等于凭空抬高可信度。
 * 先查再插是因为在事务里撞唯一约束会把整个事务废掉；
 * 库上的 @@unique 仍然留着，用来挡两个请求同时插同一行的并发。
 */
export async function recordEvidence(tx: Prisma.TransactionClient, input: EvidenceInput): Promise<void> {
  const kind = toDbKind(input.kind);
  const origin = toDbMemoryOrigin(input.origin);
  const sourceMessageId = input.sourceMessageId ?? null;

  const existing = await tx.memoryEvidence.findFirst({
    where: { userId: input.userId, memoryId: input.memoryId, kind, sourceMessageId }
  });
  if (existing) return;

  const id = randomUUID();
  const note = input.note?.trim() ? input.note.trim() : null;
  await tx.memoryEvidence.create({
    data: {
      id,
      userId: input.userId,
      memoryId: input.memoryId,
      kind,
      origin,
      sourceMessageId,
      sourceChatId: input.sourceChatId ?? null,
      noteCiphertext: note ? encryptCognitiveString(note, noteAad(input.userId, id)) : null
    }
  });
}

/**
 * 不在事务里时用这个：记一条「用户又原话说了一遍」的独立证据。
 *
 * 这类证据是附带记录，没有需要跟它同生共死的主写入，所以不必开事务。
 * PrismaClient 在结构上就是 TransactionClient 的超集，这里的断言只是让类型对上。
 */
export async function recordEvidenceOutsideTransaction(input: EvidenceInput): Promise<void> {
  await recordEvidence(prisma as Prisma.TransactionClient, input);
}

/** 一条记忆的证据。按调用者自己的 userId 取，别人的证据一条也不给。 */
export async function listEvidence(memoryId: string, userId: string): Promise<EvidenceDto[]> {
  const rows = (await prisma.memoryEvidence.findMany({
    where: { userId, memoryId },
    orderBy: { createdAt: 'desc' }
  })) as unknown as EvidenceRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: fromDbKind(row.kind),
    origin: fromDbMemoryOrigin(row.origin),
    sourceMessageId: row.sourceMessageId,
    sourceChatId: row.sourceChatId,
    note: decryptNote(row, userId),
    createdAt: row.createdAt.toISOString()
  }));
}

/**
 * 一屏记忆的再巩固检查要看的两列：方向和时间（任务书 7.1）。
 *
 * 和 assessMemories 同一个理由：一次查完，不逐条往返。说明文字的密文这里不取——
 * 检查只看「什么时候、哪个方向」，把密文读回来等于多一处解密和一处失败可能。
 * 方向映射仍然只有 fromDbKind 一份，所以这个函数留在证据账本里，不搬到 reconsolidation.ts。
 */
export async function listEvidenceRows(
  userId: string,
  memoryIds: readonly string[]
): Promise<Array<{ memoryId: string; kind: EvidenceKind; createdAt: string }>> {
  if (memoryIds.length === 0) return [];
  const rows = await prisma.memoryEvidence.findMany({
    where: { userId, memoryId: { in: [...memoryIds] } },
    orderBy: { createdAt: 'asc' },
    select: { memoryId: true, kind: true, createdAt: true }
  });
  return rows.map((row) => ({
    memoryId: row.memoryId,
    kind: fromDbKind(row.kind),
    createdAt: row.createdAt.toISOString()
  }));
}

function decryptNote(row: EvidenceRow, viewerUserId: string): string | null {
  if (!row.noteCiphertext) return null;
  if (row.userId !== viewerUserId) return null;
  try {
    return decryptCognitiveString(row.noteCiphertext, noteAad(row.userId, row.id));
  } catch {
    return '（说明解密失败）';
  }
}

/**
 * 一批记忆的置信度，一次 groupBy 查完。
 *
 * 逐条查的话，注入 8 条记忆就是 8 次往返；而证据行本来就按 (memoryId, kind) 聚合得起来。
 * where 里始终带 userId：别人的证据不许抬 high 自己的记忆。
 */
export async function assessMemories(
  userId: string,
  memories: readonly ConfidenceSubject[],
  now: Date = new Date()
): Promise<Map<string, Confidence>> {
  if (memories.length === 0) return new Map();

  const ids = memories.map((memory) => memory.id);
  const grouped = await prisma.memoryEvidence.groupBy({
    by: ['memoryId', 'kind'],
    where: { userId, memoryId: { in: ids } },
    _count: { _all: true }
  });

  const counts = new Map<string, EvidenceCounts>();
  for (const id of ids) counts.set(id, { supports: 0, contradicts: 0 });
  for (const row of grouped) {
    const entry = counts.get(row.memoryId);
    if (!entry) continue;
    if (row.kind === 'SUPPORTS') entry.supports = row._count._all;
    else if (row.kind === 'CONTRADICTS') entry.contradicts = row._count._all;
  }

  return assessWithCounts(memories, counts, now);
}

/**
 * 已经有计数时直接算档位——纯函数，不碰数据库。
 *
 * 拆这一层不是为了好看：认知评测 Harness 要在离线跑置信度这一环，
 * 而它手里只有 fixture 里的证据条数，没有库。评分规则仍然只有 assessConfidence 一份。
 * 计数里缺席的记忆按零证据算，不是跳过——「没查到」和「没算」是两回事。
 */
export function assessWithCounts(
  memories: readonly ConfidenceSubject[],
  counts: ReadonlyMap<string, EvidenceCounts>,
  now: Date = new Date()
): Map<string, Confidence> {
  const result = new Map<string, Confidence>();
  for (const memory of memories) {
    const entry = counts.get(memory.id) ?? { supports: 0, contradicts: 0 };
    result.set(
      memory.id,
      assessConfidence({
        origin: memory.origin,
        confirmedAt: memory.confirmedAt,
        supersededAt: memory.supersededAt,
        validTo: memory.validTo,
        supports: entry.supports,
        contradicts: entry.contradicts,
        now
      })
    );
  }
  return result;
}
