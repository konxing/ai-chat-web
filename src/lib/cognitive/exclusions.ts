import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { hmacHex } from '@/lib/crypto';
import type { CognitiveAadCoord } from './aad';
import { decryptCognitiveString, encryptCognitiveString } from './aad';
import { loadEnv } from '@/lib/env';
import { normalizeForMatch } from './normalize';
import type { Prisma } from '@prisma/client';

/**
 * 来源排除规则（任务书 7.3：「需要建立来源排除规则，防止后台再次提取相同信息」）。
 *
 * 落点在写侧。后台那条队列（任务书 §6）只跑「已经欠下的那一轮」，不会重扫历史消息，
 * 所以同一句话被重新记住的真实路径仍然是用户后来又说了一遍——排除规则因此按
 * 「归一化后的正文」匹配，不按 sourceMessageId：换一条消息重说同一件事，消息 id 就变了，
 * 按 id 排除等于什么都没排除。
 * sourceMessageId 和 chatId 仍然存下来，但只作为「这条排除是哪来的」的追溯信息。
 *
 * 匹配值是 HMAC(APP_SECRET, userId:归一化正文)：能 O(1) 比对，又不是明文的等价物
 * （拿不到 APP_SECRET 就没法用字典把它反查出来）。userId 进 HMAC，
 * 所以两个账号删掉同一句话得到的是两个不同的值，谁的表也认不出谁的。
 *
 * 另存一份密文只为了界面能显示和撤销：只有哈希的话，用户面对一排指纹认不出哪条是哪条，
 * 撤销权就成了摆设。密文和别处一样绑 userId + 行 id 做 AAD。
 *
 * 上限 500 条，超了淘汰最旧的。排除表是隐私控件，但不能变成一张无限增长的表。
 * 测试：tests/unit/cognitive-exclusions.test.ts
 */

export const MAX_EXCLUSIONS_PER_USER = 500;

interface ExclusionRow {
  id: string;
  userId: string;
  contentHash: string;
  contentCiphertext: string;
  chatId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
}

export interface ExclusionDto {
  id: string;
  content: string;
  chatId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
}

export interface ExclusionSource {
  content: string;
  chatId?: string | null;
  sourceMessageId?: string | null;
}

// 排除规则存的是那句被否掉的话本身，所以它跟记忆正文同等加密。封口走 aad.ts 那一份四坐标口径。
const contentAad = (userId: string, id: string): CognitiveAadCoord => ({
  purpose: 'memory-exclusion',
  userId,
  recordId: id,
  fieldName: 'contentCiphertext'
});

function secret(): Buffer {
  return Buffer.from(loadEnv().APP_SECRET, 'utf8');
}

export function exclusionHash(userId: string, content: string): string {
  return hmacHex(secret(), `${userId}:${normalizeForMatch(content)}`);
}

/**
 * 把刚删掉的内容记进排除表。调用方在事务里调，所以「行删掉了但排除没记上」这种半截状态不存在。
 * 返回真正新增的条数：已经排除过的同一句话不重复入库。
 */
export async function recordExclusions(
  tx: Prisma.TransactionClient,
  userId: string,
  sources: readonly ExclusionSource[]
): Promise<number> {
  const pending = new Map<string, ExclusionSource>();
  for (const source of sources) {
    const content = source.content.trim();
    if (!content) continue;
    // 一批里的重复句子先并掉：同一句话删两遍不该占两个名额。
    pending.set(exclusionHash(userId, content), source);
  }
  if (pending.size === 0) return 0;

  const existing = await tx.memoryExclusion.findMany({
    where: { userId, contentHash: { in: [...pending.keys()] } },
    select: { contentHash: true }
  });
  for (const row of existing) pending.delete(row.contentHash);
  if (pending.size === 0) return 0;

  let created = 0;
  for (const [contentHash, source] of pending) {
    const id = randomUUID();
    await tx.memoryExclusion.create({
      data: {
        id,
        userId,
        contentHash,
        contentCiphertext: encryptCognitiveString(source.content.trim(), contentAad(userId, id)),
        chatId: source.chatId ?? null,
        sourceMessageId: source.sourceMessageId ?? null
      }
    });
    created += 1;
  }

  await evictOldest(tx, userId);
  return created;
}

async function evictOldest(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const total = await tx.memoryExclusion.count({ where: { userId } });
  const excess = total - MAX_EXCLUSIONS_PER_USER;
  if (excess <= 0) return;
  const oldest = await tx.memoryExclusion.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: excess,
    select: { id: true }
  });
  if (oldest.length === 0) return;
  await tx.memoryExclusion.deleteMany({ where: { userId, id: { in: oldest.map((row) => row.id) } } });
}

/** 写侧每轮要拿的是「哪些句子已经被排除」，只需要哈希，不需要解密任何正文。 */
export async function excludedHashes(userId: string): Promise<Set<string>> {
  const rows = await prisma.memoryExclusion.findMany({ where: { userId }, select: { contentHash: true } });
  return new Set(rows.map((row) => row.contentHash));
}

export async function listExclusions(userId: string): Promise<ExclusionDto[]> {
  const rows = (await prisma.memoryExclusion.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: MAX_EXCLUSIONS_PER_USER
  })) as unknown as ExclusionRow[];
  return rows.map((row) => {
    let content: string;
    try {
      content = decryptCognitiveString(row.contentCiphertext, contentAad(row.userId, row.id));
    } catch {
      content = '（内容解密失败）';
    }
    return {
      id: row.id,
      content,
      chatId: row.chatId,
      sourceMessageId: row.sourceMessageId,
      createdAt: row.createdAt.toISOString()
    };
  });
}

/** 撤销一条排除＝允许这句话重新被记住。不属于当前用户或已经不在都返回 false，不报错。 */
export async function removeExclusion(id: string, userId: string): Promise<boolean> {
  const result = await prisma.memoryExclusion.deleteMany({ where: { id, userId } });
  return result.count > 0;
}
