import { prisma } from '@/lib/prisma';
import { vectorFromRow } from './embedding';

/**
 * 仅为语义召回读取当前候选记忆的加密向量。
 * 查询以 userId + 记忆 id 双重约束，解密失败的行不参与排序。
 * 绝不将密文、明文向量或个人信息写入日志。
 */
export async function findStoredMemoryVectors(
  userId: string,
  ids: readonly string[]
): Promise<Map<string, { model: string; vector: Float32Array }>> {
  const result = new Map<string, { model: string; vector: Float32Array }>();
  if (ids.length === 0) return result;
  const rows = await prisma.memoryItem.findMany({
    where: { userId, id: { in: [...new Set(ids)] }, embeddingCiphertext: { not: null } },
    select: { id: true, embeddingModel: true, embeddingCiphertext: true }
  });
  for (const row of rows) {
    if (!row.embeddingModel || !row.embeddingCiphertext) continue;
    try {
      const vector = vectorFromRow(Buffer.from(row.embeddingCiphertext), userId, row.id);
      if (vector.length > 0) result.set(row.id, { model: row.embeddingModel, vector });
    } catch {
      // 单条密文异常不应阻断其它记忆的检索。
    }
  }
  return result;
}
