import { prisma } from '@/lib/prisma';
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
 * 派生数据当前只有演化边一种。Embedding、图关系、时间线派生、反思候选、决策关联、
 * 认知任务都还没落地（任务书 7.3 列了这些），等它们出现时这里要跟着加清理。
 *
 * 删记忆不删原会话：7.3 明确要求区分这两件事，用户只说「忘掉这条」时不许动聊天记录。
 * 反过来，删会话会连带删掉它产生的记忆——那是 MemoryItem.chat 上既有的 CASCADE。
 */

/** 摘开指向这批行的演化边。userId 带在条件里：别人的边一条都不许碰。 */
async function detachEdges(tx: Prisma.TransactionClient, userId: string, ids: string[]): Promise<void> {
  await tx.memoryRevision.updateMany({
    where: { userId, previousId: { in: ids } },
    data: { previousId: null }
  });
}

/** 删掉一条记忆。不属于当前用户或者已经不存在都返回 0，不报错——调用方按 404 处理。 */
export async function purgeMemory(memoryId: string, userId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await detachEdges(tx, userId, [memoryId]);
    const result = await tx.memoryItem.deleteMany({ where: { id: memoryId, userId } });
    return result.count;
  });
}

/** 忘记某次对话产生的全部记忆，对话本身保留。 */
export async function purgeMemoriesByChat(chatId: string, userId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.memoryItem.findMany({ where: { userId, chatId }, select: { id: true } });
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    await detachEdges(tx, userId, ids);
    const result = await tx.memoryItem.deleteMany({ where: { userId, id: { in: ids } } });
    return result.count;
  });
}

/**
 * 清空这个用户的全部长期记忆。
 * 不需要先摘边：每条演化边的 memoryId 都指向本用户某一行，全删之下级联会把边一并清掉。
 */
export async function purgeAllMemories(userId: string): Promise<number> {
  const result = await prisma.memoryItem.deleteMany({ where: { userId } });
  return result.count;
}
