import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { decryptMemoryContent } from './memories';
import { fromDbMemoryContext, type MemoryContext } from './policy';
import { recordPolicySignal } from './policy-learner';
import { recordExclusions, type ExclusionSource } from './exclusions';
import type { Prisma } from '@prisma/client';

/**
 * 永久删除（任务书 7.2 的 DELETE、7.3 的用户遗忘功能、7.4 门槛 2「派生数据按策略清理」）。
 *
 * 和「撤回」的区别是硬的：撤回只把来源标成 RETRACTED，行和正文都留着；这里是把行删掉，
 * 不可恢复。两条路都要留着——用户「不想让 AI 记着这个」和「这条从来没存在过」是两件事。
 *
 * 删之前必须先处理演化边。MemoryRevision.previousId 的外键是 ON DELETE CASCADE，
 * 直接删一条旧版本会把「新版本是改口来的」那条边一起带走，活着的那一行版本链就凭空断了。
 * 所以先把指向被删行的边摘开：previousId 置 null（该列本身可空），
 * 保住「这一版来自一次改口」这个事实，同时不留任何指向已删内容的指针。
 * 至于 memoryId 指向被删行的边，那是在描述被删的这一行自己怎么来的，随外键一起消失是对的。
 *
 * 派生数据当前只有演化边和排除规则两种。Embedding、图关系、时间线派生、反思候选、
 * 决策关联、认知任务都还没落地（任务书 7.3 列了这些），等它们出现时这里要跟着加清理。
 *
 * 删记忆不删原会话：7.3 明确要求区分这两件事，用户只说「忘掉这条」时不许动聊天记录。
 * 反过来，删会话会连带删掉它产生的记忆——那是 MemoryItem.chat 上既有的 CASCADE。
 */

interface PurgeTargetRow {
  id: string;
  userId: string;
  chatId: string | null;
  sourceMessageId: string | null;
  context: string;
  contentCiphertext: string;
}

export interface PurgeResult {
  purged: number;
  /**
   * 被删记忆涉及的情境（去重）。调用方在事务提交后据此跑一次策略学习
   * （任务书 1.3：证据够了才把该情境收紧）。清空全部返回空数组——见 purgeAllMemories。
   */
  contexts: MemoryContext[];
}

/** 删掉的内容要进排除表，否则用户下次说同一句话它又被记回来了（任务书 7.3）。 */
async function recordSources(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: readonly PurgeTargetRow[]
): Promise<void> {
  const sources: ExclusionSource[] = [];
  for (const row of rows) {
    try {
      sources.push({
        content: decryptMemoryContent(row, userId),
        chatId: row.chatId,
        sourceMessageId: row.sourceMessageId
      });
    } catch {
      // 解不开就不建这一条排除，但删除照样执行：正文已经坏了，
      // 不能因为它让用户的「忘掉这条」失败。日志里只有 id，没有正文（任务书 5.5）。
      log.warn('cognitive.exclusion_skipped', { userId, memoryId: row.id, reason: 'decrypt_failed' });
    }
  }
  if (sources.length > 0) await recordExclusions(tx, userId, sources);
}

/** 摘开指向这批行的演化边。userId 带在条件里：别人的边一条都不许碰。 */
async function detachEdges(tx: Prisma.TransactionClient, userId: string, ids: string[]): Promise<void> {
  await tx.memoryRevision.updateMany({
    where: { userId, previousId: { in: ids } },
    data: { previousId: null }
  });
}

/** 删掉一条记忆。不属于当前用户或者已经不存在都返回 purged: 0，不报错——调用方按 404 处理。 */
export async function purgeMemory(memoryId: string, userId: string): Promise<PurgeResult> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.memoryItem.findFirst({ where: { id: memoryId, userId } });
    if (!row) return { purged: 0, contexts: [] };
    const target = row as unknown as PurgeTargetRow;
    const context = fromDbMemoryContext(target.context);
    await detachEdges(tx, userId, [memoryId]);
    const result = await tx.memoryItem.deleteMany({ where: { id: memoryId, userId } });
    await recordSources(tx, userId, [target]);
    // 一次删除只算一条证据，哪怕这一条同时触发了排除和演化边清理。
    await recordPolicySignal(tx, userId, context);
    return { purged: result.count, contexts: [context] };
  });
}

/** 忘记某次对话产生的全部记忆，对话本身保留。 */
export async function purgeMemoriesByChat(chatId: string, userId: string): Promise<PurgeResult> {
  return prisma.$transaction(async (tx) => {
    const rows = (await tx.memoryItem.findMany({
      where: { userId, chatId }
    })) as unknown as PurgeTargetRow[];
    if (rows.length === 0) return { purged: 0, contexts: [] };
    const ids = rows.map((row) => row.id);
    const contexts = [...new Set(rows.map((row) => fromDbMemoryContext(row.context)))];
    await detachEdges(tx, userId, ids);
    const result = await tx.memoryItem.deleteMany({ where: { userId, id: { in: ids } } });
    await recordSources(tx, userId, rows);
    // 用户点的是一次按钮：删掉 5 条技术项目记忆算一条证据，不是五条，
    // 否则一次批量清理就能把阈值刷满，那不再是「反复表达同一个意思」。
    for (const context of contexts) await recordPolicySignal(tx, userId, context);
    return { purged: result.count, contexts };
  });
}

/**
 * 清空这个用户的全部长期记忆。
 *
 * 不需要先摘边：每条演化边的 memoryId 都指向本用户某一行，全删之下级联会把边一并清掉。
 * 也**不建排除、不记学习证据**：清空是「重新开始」，不是「这些话永远别再记」，
 * 更不是「这七个情境都记太多了」。一口气给每个情境记几十条证据，
 * 等于让学习层在一次点击之后把所有情境全部收紧，而那根本不是用户表达的意思。
 * 要禁止某句话被记回来、或者要收紧某个情境，用单条删除或按会话删除。
 */
export async function purgeAllMemories(userId: string): Promise<PurgeResult> {
  const result = await prisma.memoryItem.deleteMany({ where: { userId } });
  return { purged: result.count, contexts: [] };
}
