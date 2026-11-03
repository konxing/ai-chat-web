import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { decryptMemoryContent } from './memories';
import { fromDbMemoryContext, type MemoryContext } from './policy';
import { policyLearningEnabled, recordPolicySignal } from './policy-learner';
import { recordExclusions, type ExclusionSource } from './exclusions';
import { cancelCognitiveTasks } from './task-queue';
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
 * 「删一条记忆」删的是**一整条版本链**（任务书 4.4 的「删除事件及其派生记录」）：
 * 旧版本只留着的话，它在「记忆」那一屏看不见（列表只给当前有效行），在时间线上却会
 * 因为折叠不到后继而单独成事件（`timeline.ts:96-101`），于是用户删掉的内容换了一副样子回来。
 * 所以 purged 报的是行数不是事件数，界面那句话得跟着说清。
 *
 * 派生数据当前有三种：演化边、排除规则，以及还没跑的认知任务（任务书 §6 的 CognitiveTask）。
 * 撤任务必须和删行在同一个事务里：否则记忆删完了，事务外那条还排着队，
 * 用户看到的「忘记这次对话」会在下一次轮询时被 worker 推翻。
 * Embedding、图关系、时间线派生、反思候选、决策关联都还没落地（任务书 7.3 列了这些），
 * 等它们出现时这里要跟着加清理。
 *
 * 删记忆不删原会话：7.3 明确要求区分这两件事，用户只说「忘掉这条」时不许动聊天记录。
 * 反过来，删会话会连带删掉它产生的记忆和欠着的认知任务——那是各自 chat 外键上的 CASCADE。
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

/**
 * 这一条事件占着哪几行：顺着「这一版是改口来的」那条边往回走。
 *
 * 排序和折叠口径跟 `memories.ts:479` 的 `listRevisionEdges` 一致（`createdAt asc`、一个版本只认第一条边），
 * 所以「时间线上折叠到一起的那几行」和「这里收集到的那几行」是同一批——两处口径一漂，
 * 就会出现「界面折叠三条、删除只删一条」。
 * 环是数据异常不是常态，但 `seen` 是必须有的：没有它，一次异常互指就能让这个循环永不结束，
 * 而它跑在删除事务里，等着它的是数据库连接被一直占着。
 */
async function eventChainIds(tx: Prisma.TransactionClient, userId: string, headId: string): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = headId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ids.push(cursor);
    const found = (await tx.memoryRevision.findFirst({
      where: { userId, memoryId: cursor },
      orderBy: { createdAt: 'asc' },
      select: { previousId: true }
    })) as { previousId: string | null } | null;
    cursor = found?.previousId ?? null;
  }
  return ids;
}

/** 删掉一条记忆。不属于当前用户或者已经不存在都返回 purged: 0，不报错——调用方按 404 处理。 */
export async function purgeMemory(memoryId: string, userId: string): Promise<PurgeResult> {
  // 闸门开在事务之前：关掉学习时这一轮一条证据都不攒，事务里也就少一次写入。
  const recordSignals = await policyLearningEnabled(userId);
  return prisma.$transaction(async (tx) => {
    const head = await tx.memoryItem.findFirst({ where: { id: memoryId, userId } });
    if (!head) return { purged: 0, contexts: [] };
    // 「事件」是整条版本链，不是当前那一行：留着旧版本，它们过一遍时间线就会
    // 作为折叠不到后继的孤行重新成事件——用户刚删掉的内容被摆回他眼前。
    const ids = await eventChainIds(tx, userId, head.id);
    const rows = (await tx.memoryItem.findMany({
      where: { userId, id: { in: ids } }
    })) as unknown as PurgeTargetRow[];
    const contexts = [...new Set(rows.map((row) => fromDbMemoryContext(row.context)))];
    await detachEdges(tx, userId, ids);
    const result = await tx.memoryItem.deleteMany({ where: { userId, id: { in: ids } } });
    await recordSources(tx, userId, rows);
    // 来源那次对话还欠着的活也一起撤：排除规则挡得住「同一句原话再记一遍」，
    // 挡不住换个说法的那一句。没有来源对话的记忆不去动别人的队列。
    if (head.chatId) await cancelCognitiveTasks(tx, { userId, chatId: head.chatId });
    // 一次删除按情境各记一条证据，不是按行数：用户点的是一个按钮，
    // 一版接一版的同一件事更不该被数成「他反复表达了五次这个意思」。
    for (const context of contexts) if (recordSignals) await recordPolicySignal(tx, userId, context);
    return { purged: result.count, contexts };
  });
}

/** 忘记某次对话产生的全部记忆，对话本身保留。 */
export async function purgeMemoriesByChat(chatId: string, userId: string): Promise<PurgeResult> {
  const recordSignals = await policyLearningEnabled(userId);
  return prisma.$transaction(async (tx) => {
    // 撤账排在「有没有记忆可删」之前：这一轮可能刚说完，记忆还压在队列里没跑，
    // 那时候行数是 0，但用户要忘记的是这次对话，等它跑完再补记就是把那句话塞回来。
    await cancelCognitiveTasks(tx, { userId, chatId });
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
    for (const context of contexts) if (recordSignals) await recordPolicySignal(tx, userId, context);
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
 *
 * 欠账要撤——它是按用户撤的，和「清空」这个动作的范围正好一致。
 */
export async function purgeAllMemories(userId: string): Promise<PurgeResult> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.memoryItem.deleteMany({ where: { userId } });
    await cancelCognitiveTasks(tx, { userId });
    return { purged: result.count, contexts: [] };
  });
}
