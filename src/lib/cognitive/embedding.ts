import type { AiProvider } from '@prisma/client';
import { ApiError } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { decryptBuffer, encryptBuffer } from '@/lib/crypto';
import { readBodyCapped } from '@/lib/ai';
import { decryptProviderKey, pickCapableProvider } from '@/lib/providers';
import { joinApiPath, resolveProviderTarget, safeFetch } from '@/lib/ssrf';

/**
 * 记忆向量的出站与加解密（任务书 3.2 的语义召回那一半）。
 *
 * 为什么存密文而不是 pgvector：本机实测过——`vector` 不在 `pg_available_extensions` 里，
 * Prisma 6.11 没有 `Vector` 类型，`Unsupported("vector")` 列对生成的客户端根本不可见，
 * 而密文列也建不了 HNSW 索引。所以这里只剩应用层算余弦这一条路，
 * 于是「存下来的 embedding 算不算明文记忆」这条红线按构造回答：它和正文一样是密文。
 *
 * 精度取 float32：余弦只看方向，第 7 位以后的数字对排序没有影响，而维度换来一半体积。
 */

/** 与 chat 那条路同一个包体上限：对面不老实时不整包吞进内存。 */
const MAX_BODY_BYTES = 2_000_000;
/** 错误页只用来做诊断，取够一小截就撤。 */
const MAX_ERROR_BYTES = 8_192;
/**
 * 维度上限。包体没超不代表那一串数能用：一万七千维既算不动也没法比对，
 * 挡在这里比让它写进库再悄悄拖垮读侧好。
 */
export const MAX_EMBEDDING_DIM = 8_192;
const TIMEOUT_MS = 15_000;

/** AAD 绑到字段名：正文那份密文和向量那份不是同一把凭据，不能互换着解。 */
const aadForVector = (userId: string, memoryId: string) => `memory-vector:v1:${userId}:${memoryId}`;

export interface StoredVector {
  ciphertext: Buffer;
  model: string;
}

export function packVector(vector: readonly number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index]!, index * 4);
  return buffer;
}

export function unpackVector(payload: Buffer): Float32Array {
  const vector = new Float32Array(Math.floor(payload.length / 4));
  for (let index = 0; index < vector.length; index += 1) vector[index] = payload.readFloatLE(index * 4);
  return vector;
}

/** 解一行里存的向量；AAD 对不上（记忆 id 或用户不对）就抛，绝不返回半个向量。 */
export function vectorFromRow(ciphertext: Buffer, userId: string, memoryId: string): Float32Array {
  return unpackVector(decryptBuffer(ciphertext, aadForVector(userId, memoryId)));
}

function validate(vector: unknown, model: string): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_EMBEDDING_DIM) {
    throw new ApiError(502, 'BAD_EMBEDDING', `语义向量维度不可用（模型 ${model}）`);
  }
  let sumSquares = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ApiError(502, 'BAD_EMBEDDING', '语义向量里有非数字分量');
    }
    sumSquares += value * value;
  }
  if (sumSquares === 0) {
    throw new ApiError(502, 'BAD_EMBEDDING', '语义向量是零向量，算不出相关度');
  }
  return vector;
}

/**
 * 把一段文本算成向量并加密。任何一步不对都抛 `ApiError`——调用方是后台任务，
 * 它该把这一条记忆照常留着，而不是让一趟可选的增益把写入带倒。
 */
export async function embedMemoryText(userId: string, memoryId: string, text: string): Promise<StoredVector> {
  // 候选范围与挑法沿用语音转写那一条：本人私有加全局、只要启用的，按能力挑第一条。
  const rows = await prisma.aiProvider.findMany({
    where: {
      enabled: true,
      OR: [{ ownerType: 'GLOBAL' }, { ownerType: 'USER', userId }]
    },
    orderBy: [{ ownerType: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }]
  });
  const provider = pickCapableProvider(rows, 'embedding');
  if (!provider) throw new ApiError(503, 'NO_EMBEDDING_MODEL', '尚未配置支持语义向量的模型');

  const key = decryptProviderKey(provider as AiProvider);
  const target = await resolveProviderTarget(provider.baseUrl);
  const url = joinApiPath(provider.baseUrl, '/embeddings');
  const safe = await safeFetch(target, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ model: provider.modelId, input: text }),
    timeoutMs: TIMEOUT_MS
  });
  try {
    if (!safe.response.ok) {
      const status = safe.response.status;
      await readBodyCapped(safe.response, MAX_ERROR_BYTES).catch(() => ({ text: '', truncated: true }));
      throw new ApiError(502, 'EMBEDDING_FAILED', `语义向量服务返回 HTTP ${status}`);
    }
    const { text: raw, truncated } = await readBodyCapped(safe.response, MAX_BODY_BYTES);
    if (truncated) throw new ApiError(502, 'EMBEDDING_FAILED', '语义向量返回体超过上限');
    const parsed = JSON.parse(raw) as { data?: { embedding?: unknown }[] };
    const vector = validate(parsed.data?.[0]?.embedding, provider.modelId);
    return {
      ciphertext: encryptBuffer(packVector(vector), aadForVector(userId, memoryId)),
      model: provider.modelId
    };
  } catch (err) {
    if (err instanceof SyntaxError) throw new ApiError(502, 'BAD_EMBEDDING', '语义向量返回的不是 JSON');
    throw err;
  } finally {
    await safe.close().catch(() => undefined);
  }
}
