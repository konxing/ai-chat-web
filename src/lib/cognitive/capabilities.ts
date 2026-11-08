import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { encryptString, decryptString } from '@/lib/crypto';
import { cognitiveColumnAad } from './encrypted-columns';

const coord = (model: string, column: string, userId: string, id: string) =>
  cognitiveColumnAad(model, column, userId, id);
const seal = (text: string, model: string, column: string, userId: string, id: string) =>
  encryptString(text, coord(model, column, userId, id));
const unseal = (text: string, model: string, column: string, userId: string, id: string) =>
  decryptString(text, coord(model, column, userId, id));

export async function requireDimension(userId: string, id: string) {
  const dimension = await prisma.capabilityDimension.findFirst({ where: { id, userId } });
  if (!dimension) throw new ApiError(404, 'CAPABILITY_NOT_FOUND', '能力维度不存在');
  return dimension;
}

export function publicDimension(row: {
  id: string; userId: string; key: string; titleCiphertext: string; goalCiphertext: string | null;
  enabled: boolean; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: row.id, key: row.key,
    title: unseal(row.titleCiphertext, 'CapabilityDimension', 'titleCiphertext', row.userId, row.id),
    goal: row.goalCiphertext ? unseal(row.goalCiphertext, 'CapabilityDimension', 'goalCiphertext', row.userId, row.id) : null,
    enabled: row.enabled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

export async function listDimensions(userId: string) {
  const rows = await prisma.capabilityDimension.findMany({
    where: { userId }, orderBy: { createdAt: 'asc' }, take: 40
  });
  return rows.map(publicDimension);
}

export async function createDimension(userId: string, input: { key: string; title: string; goal?: string | null }) {
  const id = randomUUID();
  const exists = await prisma.capabilityDimension.findFirst({ where: { userId, key: input.key } });
  if (exists) throw new ApiError(409, 'CAPABILITY_EXISTS', '该能力标识已经存在');
  const count = await prisma.capabilityDimension.count({ where: { userId } });
  if (count >= 40) throw new ApiError(400, 'CAPABILITY_LIMIT', '最多创建 40 个能力维度');
  const row = await prisma.capabilityDimension.create({
    data: {
      id, userId, key: input.key,
      titleCiphertext: seal(input.title, 'CapabilityDimension', 'titleCiphertext', userId, id),
      goalCiphertext: input.goal ? seal(input.goal, 'CapabilityDimension', 'goalCiphertext', userId, id) : null
    }
  });
  return publicDimension(row);
}

export async function updateDimension(
  userId: string, id: string, patch: { title?: string; goal?: string | null; enabled?: boolean }
) {
  await requireDimension(userId, id);
  const row = await prisma.capabilityDimension.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? {
        titleCiphertext: seal(patch.title, 'CapabilityDimension', 'titleCiphertext', userId, id)
      } : {}),
      ...(patch.goal !== undefined ? {
        goalCiphertext: patch.goal ? seal(patch.goal, 'CapabilityDimension', 'goalCiphertext', userId, id) : null
      } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {})
    }
  });
  return publicDimension(row);
}

export async function deleteDimension(userId: string, id: string) {
  const result = await prisma.capabilityDimension.deleteMany({ where: { id, userId } });
  if (!result.count) throw new ApiError(404, 'CAPABILITY_NOT_FOUND', '能力维度不存在');
  // The database cascades all evidence, snapshots, and interventions under this dimension.
  return { deleted: true };
}

export async function listEvidence(userId: string, dimensionId: string) {
  await requireDimension(userId, dimensionId);
  const rows = await prisma.capabilityEvidence.findMany({
    where: { userId, dimensionId }, orderBy: { observedAt: 'desc' }, take: 100
  });
  return rows.map((row) => ({
    id: row.id, dimensionId: row.dimensionId, kind: row.kind,
    score: row.score,
    note: unseal(row.noteCiphertext, 'CapabilityEvidence', 'noteCiphertext', userId, row.id),
    observedAt: row.observedAt.toISOString(), sourceMessageId: row.sourceMessageId
  }));
}

/** Evidence is opt-in: never mine private chats into a numerical ability score automatically. */
export async function addEvidence(userId: string, dimensionId: string, input: {
  kind: 'SELF_REPORT' | 'TASK_RESULT'; score?: number | null; note: string;
  observedAt?: string; sourceMessageId?: string;
}) {
  const dimension = await requireDimension(userId, dimensionId);
  if (!dimension.enabled) throw new ApiError(409, 'CAPABILITY_DISABLED', '该能力维度已暂停');
  if (input.sourceMessageId) {
    const source = await prisma.message.findFirst({
      where: { id: input.sourceMessageId, chat: { userId } }, select: { id: true }
    });
    if (!source) throw new ApiError(400, 'SOURCE_NOT_OWNED', '引用的消息不存在或不属于当前用户');
  }
  const id = randomUUID();
  const row = await prisma.capabilityEvidence.create({
    data: {
      id, userId, dimensionId, kind: input.kind, score: input.score ?? null,
      noteCiphertext: seal(input.note, 'CapabilityEvidence', 'noteCiphertext', userId, id),
      observedAt: input.observedAt ? new Date(input.observedAt) : new Date(),
      sourceMessageId: input.sourceMessageId ?? null
    }
  });
  return {
    id: row.id, dimensionId, kind: row.kind, score: row.score,
    note: input.note, observedAt: row.observedAt.toISOString(), sourceMessageId: row.sourceMessageId
  };
}

export async function deleteEvidence(userId: string, dimensionId: string, evidenceId: string) {
  await requireDimension(userId, dimensionId);
  const result = await prisma.capabilityEvidence.deleteMany({
    where: { id: evidenceId, userId, dimensionId }
  });
  if (!result.count) throw new ApiError(404, 'EVIDENCE_NOT_FOUND', '证据记录不存在');
  // Cached snapshots must not retain scores derived from deleted evidence.
  await prisma.capabilitySnapshot.deleteMany({ where: { userId, dimensionId } });
  return { deleted: true };
}
