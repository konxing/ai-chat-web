import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { encryptString, decryptString } from '@/lib/crypto';
import { cognitiveColumnAad } from './encrypted-columns';
import { requireDimension } from './capabilities';

const aad = (column: string, userId: string, id: string) =>
  cognitiveColumnAad('InterventionRecord', column, userId, id);

function present(row: {
  id: string; userId: string; dimensionId: string; suggestionCiphertext: string;
  feedbackCiphertext: string | null; effectiveness: number | null; status: string; source: string;
  createdAt: Date; updatedAt: Date; completedAt: Date | null;
}) {
  return {
    id: row.id, dimensionId: row.dimensionId, source: row.source, status: row.status,
    suggestion: decryptString(row.suggestionCiphertext, aad('suggestionCiphertext', row.userId, row.id)),
    feedback: row.feedbackCiphertext ?
      decryptString(row.feedbackCiphertext, aad('feedbackCiphertext', row.userId, row.id)) : null,
    effectiveness: row.effectiveness,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null
  };
}

export async function listInterventions(userId: string, dimensionId: string) {
  await requireDimension(userId, dimensionId);
  const rows = await prisma.interventionRecord.findMany({
    where: { userId, dimensionId }, orderBy: { createdAt: 'desc' }, take: 50
  });
  return rows.map(present);
}

export async function updateIntervention(
  userId: string, dimensionId: string, interventionId: string,
  input: { status: 'ACCEPTED' | 'SKIPPED' | 'COMPLETED'; feedback?: string | null; effectiveness?: number | null }
) {
  await requireDimension(userId, dimensionId);
  const existing = await prisma.interventionRecord.findFirst({
    where: { id: interventionId, userId, dimensionId }
  });
  if (!existing) throw new ApiError(404, 'INTERVENTION_NOT_FOUND', '建议记录不存在');

  const allowed: Record<string, readonly string[]> = {
    PROPOSED: ['ACCEPTED', 'SKIPPED'], ACCEPTED: ['COMPLETED', 'SKIPPED']
  };
  if (!allowed[existing.status]?.includes(input.status)) {
    throw new ApiError(409, 'INVALID_TRANSITION', '当前建议状态不允许该操作');
  }
  if (input.effectiveness !== undefined && input.status !== 'COMPLETED') {
    throw new ApiError(400, 'INVALID_FEEDBACK', '只能对已完成的建议评价效果');
  }
  // Status in the conditional update protects against double-submit and competing clients.
  const stamped = await prisma.interventionRecord.updateMany({
    where: { id: interventionId, userId, dimensionId, status: existing.status },
    data: {
      status: input.status,
      completedAt: input.status === 'COMPLETED' ? new Date() : null,
      ...(input.feedback !== undefined ? {
        feedbackCiphertext: input.feedback ?
          encryptString(input.feedback, aad('feedbackCiphertext', userId, interventionId)) : null
      } : {}),
      ...(input.effectiveness !== undefined ? { effectiveness: input.effectiveness } : {})
    }
  });
  if (!stamped.count) throw new ApiError(409, 'STALE_INTERVENTION', '状态已变化，请刷新');
  const updated = await prisma.interventionRecord.findFirst({
    where: { id: interventionId, userId, dimensionId }
  });
  if (!updated) throw new ApiError(404, 'INTERVENTION_NOT_FOUND', '建议记录不存在');
  return present(updated);
}

export async function deleteIntervention(userId: string, dimensionId: string, interventionId: string) {
  await requireDimension(userId, dimensionId);
  const result = await prisma.interventionRecord.deleteMany({
    where: { id: interventionId, userId, dimensionId }
  });
  if (!result.count) throw new ApiError(404, 'INTERVENTION_NOT_FOUND', '建议记录不存在');
  return { deleted: true };
}

export async function recentInterventionFeedback(userId: string, dimensionId: string) {
  const rows = await prisma.interventionRecord.findMany({
    where: { userId, dimensionId, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' }, take: 6
  });
  return rows.map((row) => ({
    suggestion: decryptString(row.suggestionCiphertext,
      aad('suggestionCiphertext', userId, row.id)).slice(0, 300),
    effectiveness: row.effectiveness,
    feedback: row.feedbackCiphertext ?
      decryptString(row.feedbackCiphertext, aad('feedbackCiphertext', userId, row.id)).slice(0, 300) : null
  }));
}
