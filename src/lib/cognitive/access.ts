import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import type { Prisma } from '@prisma/client';

/**
 * 检索访问记录（任务书 7.1「记忆被再次调用时」——那次调用今天得先成为一件事实）。
 *
 * 这一层唯一的目标是**把「这一轮哪几条记忆真进了提示词」记下来**，为 7.1 的五项检查提供凭据。
 * 它刻意不回答「这条记忆有多可信」：
 *
 * 「检索次数不能直接提高事实可信度。访问频率只能影响检索排序，不能替代证据。」
 *
 * 这条红线靠形状守着，不靠自觉：计数不在 MemoryItem 那一行上（那一行的 supersededAt、validTo
 * 正是 assessConfidence 在读的列），而在另一张表里；算置信度的 evidence.ts / confidence.ts
 * 和挑记忆的 retrieval.ts 都不 import 这个模块。用例把这些都钉住了。
 *
 * 行里只有 id 没有正文——抄 CognitiveTask 那张表的口径：「没有可以放正文的列」
 * 比「我们承诺不放正文」难违反得多。也正因为只有 id，删一条记忆就能把它的访问痕迹删干净。
 *
 * 幂等锚点是 sourceMessageId，靠库层 @@unique 兜而不是服务层记得先查（任务书 5.1）：
 * 同一条消息重发（网络重试、用户按两下）不该记成两次访问，否则「被带到 3 次」里
 * 有一多半是重试。
 *
 * 这张表上没有 chatId：「这一轮发生在哪次对话」本来就等于 sourceMessageId 那条消息所在的会话，
 * 多一列没有读者；而会话被真删掉时，这一行靠 sourceMessageId 那条外键级联自己走。
 * 「按来源会话忘记记忆」因此不能顺着这张表删——那里的 chatId 是检索发生的会话，
 * 和记忆来源的会话是两个集合（口径在 forgetting.ts）。
 *
 * 写入永不抛：调用点在 SSE 的 close() 之后，那一刻字节已经交付完，
 * 这一轮的记忆值不值得把整条流断掉，答案是不值得。契约照抄 enqueueCognitiveTask。
 *
 * 测试：tests/unit/cognitive-access.test.ts
 */

/** 统计窗口：最近 200 轮。和记忆列表一样是「有界的读」，不是全表扫描。 */
export const MEMORY_ACCESS_MAX_ROWS = 200;

export interface MemoryAccessInput {
  userId: string;
  sourceMessageId: string;
  memoryIds: readonly string[];
}

export interface MemoryAccessStat {
  memoryId: string;
  /** 最近 200 轮里这一条被带进提示词的次数。 */
  count: number;
  /** 最后一次出现的那一轮的时间（ISO），不是全局最后一轮的时间。 */
  lastAt: string;
}

export interface AccessStats {
  byMemory: Map<string, MemoryAccessStat>;
  /** 真正参与统计的轮数，也就是窗口里有多少行。 */
  scannedTurns: number;
  /** 窗口被 200 轮截断过——此时 count 是下限，界面要说实话。 */
  capped: boolean;
}

/**
 * 记一轮访问。返回值只回答「这次是不是真的记下了新的一轮」：
 * false 包含「这一轮没带记忆」「同一句话已经记过」「写库失败」三种，调用方都不必区分。
 */
export async function recordMemoryAccess(input: MemoryAccessInput): Promise<boolean> {
  if (input.memoryIds.length === 0) return false;
  try {
    await prisma.memoryAccessTurn.create({
      data: {
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        memoryIds: [...input.memoryIds]
      }
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return false;
    log.warn('cognitive.access_write_failed', {
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      // 固定字符串，不是 err.message：驱动抛出的原文里会带上失败的字段值。
      reason: 'write_failed'
    });
    return false;
  }
}

/**
 * 按记忆统计访问。多取一行只为了知道有没有被截断——
 * 「恰好读了 200 轮」和「还有更多轮没读」在数字上一样，在诚实程度上不一样。
 */
export async function listAccessStats(userId: string): Promise<AccessStats> {
  const rows = await prisma.memoryAccessTurn.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: MEMORY_ACCESS_MAX_ROWS + 1,
    select: { memoryIds: true, createdAt: true }
  });
  const capped = rows.length > MEMORY_ACCESS_MAX_ROWS;
  const window = capped ? rows.slice(0, MEMORY_ACCESS_MAX_ROWS) : rows;

  const byMemory = new Map<string, MemoryAccessStat>();
  for (const row of window) {
    const lastAt = row.createdAt.toISOString();
    // 行按时间倒序读回来，所以一条记忆第一次出现的那一行就是它最后一次被带进提示词。
    for (const memoryId of row.memoryIds) {
      const stat = byMemory.get(memoryId);
      if (stat) stat.count += 1;
      else byMemory.set(memoryId, { memoryId, count: 1, lastAt });
    }
  }
  return { byMemory, scannedTurns: window.length, capped };
}

/**
 * 记忆被忘记时，它的访问痕迹整行走。
 *
 * 是整行删，不是把那个 id 从数组里挑出来：一个已删除记忆的 id 本身就是被删内容的痕迹，
 * 而且那一轮「同时带了哪几条」这个事实已经不完整了，留着一个残缺的组合比删掉更误导。
 *
 * 收事务客户端：「记忆行删掉了而访问行还在」这种半截状态必须在结构上不存在（门槛 2）。
 */
export async function deleteAccessForMemories(
  tx: Prisma.TransactionClient,
  userId: string,
  memoryIds: readonly string[]
): Promise<number> {
  if (memoryIds.length === 0) return 0;
  const { count } = await tx.memoryAccessTurn.deleteMany({
    where: { userId, memoryIds: { hasSome: [...memoryIds] } }
  });
  return count;
}

/** 清空全部长期记忆的口径：整个用户的行全走。 */
export async function deleteAllAccess(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const { count } = await tx.memoryAccessTurn.deleteMany({ where: { userId } });
  return count;
}
