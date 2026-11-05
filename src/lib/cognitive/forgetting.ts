import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { decryptMemoryContent } from './memories';
import { fromDbMemoryContext, toDbMemoryContext, type MemoryContext } from './policy';
import { policyLearningEnabled, recordPolicySignal } from './policy-learner';
import { recordExclusions, type ExclusionSource } from './exclusions';
import { cancelCognitiveTasks } from './task-queue';
import { deleteAccessForMemories, deleteAllAccess } from './access';
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
 * 派生数据当前有六种：演化边、排除规则、还没跑的认知任务（任务书 §6 的 CognitiveTask）、
 * 引用了被删记忆的洞察（ReflectionRecord 加它的 ReflectionCitation）、某次对话产生的决策
 * （DecisionRecord），以及检索访问痕迹（任务书 7.1 的 MemoryAccessTurn）。
 * 撤任务必须和删行在同一个事务里：否则记忆删完了，事务外那条还排着队，
 * 用户看到的「忘记这次对话」会在下一次轮询时被 worker 推翻。
 *
 * 洞察按 11-04 判的甲处理：**整条删掉**，连同它全部的引用行。只靠外键级联是最坏的结果——
 * `ReflectionCitation.memoryId` 级联带走的是引用行，洞察那一行原样活着，于是用户看到一条
 * 「标题和正文都在、证据一条不剩」的洞察。引用不分 SUPPORTS / CONTRADICTS（他同日判的「1算」）：
 * 反证也是这条洞察的证据，抽掉之后它的置信度和反证命中数就成了假数字。
 * 删掉洞察等于把 `@@unique([userId, dedupKey])` 那个主题位腾出来，之后的收割可以从剩下的
 * 证据里重新提出同主题——这是甲的已知代价，不是漏洞。
 *
 * 决策行只在「忘记这次对话」和「清空全部」里收（他同日判的「2一起收」）：单条删除**不动**它，
 * 「忘掉这条记忆」和「忘记这次对话」是两件事（7.3）。决策的结果行（DecisionOutcome）由它自己
 * 那条指向 DecisionRecord 的外键级联带走，不用显式删——它是那条决策的附属，没有独立意义。
 * Embedding 是 MemoryItem 自己的一个密文列（embeddingCiphertext），随行一起消失；
 * 图关系和时间线派生还没落地，等它们出现时这里要跟着加清理。
 *
 * 派生删除不报给用户（他同日判的「3不要报」）：`PurgeResult` 不加计数，界面文案不加句子。
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
 * 这批判掉的内容牵着哪几条洞察（11-04 判的甲 +「1算」）。
 *
 * 必须在删记忆**之前**读：`ReflectionCitation.memoryId` 是 `onDelete: Cascade`，
 * 记忆一删，引用行就被库层带走了，那时候再问「谁引用过它」就查无此据——洞察正好留在原地。
 * kind 不参与条件：反证（CONTRADICTS）也是这条洞察的证据，抽掉它剩下的置信度是假的。
 * decisionIds 传空数组就是「这一轮不收决策」——单条删除走的就是这条路（口径边界）。
 */
async function insightIdsCiting(
  tx: Prisma.TransactionClient,
  userId: string,
  memoryIds: string[],
  decisionIds: string[]
): Promise<string[]> {
  const found = new Set<string>();
  if (memoryIds.length > 0) {
    const rows = await tx.reflectionCitation.findMany({
      where: { userId, memoryId: { in: memoryIds } },
      select: { reflectionId: true }
    });
    for (const row of rows) found.add(row.reflectionId);
  }
  if (decisionIds.length > 0) {
    const rows = await tx.reflectionCitation.findMany({
      where: { userId, decisionId: { in: decisionIds } },
      select: { reflectionId: true }
    });
    for (const row of rows) found.add(row.reflectionId);
  }
  return [...found];
}

/**
 * 删洞察：先删它的引用行，再删洞察行。
 *
 * 反过来在真库上也会被 `ReflectionCitation.reflectionId` 的级联带走，但显式删的两层意思：
 * 一是这一屏不该留下「指向已删洞察的引用行」哪怕一瞬间，二是**测试只看得见显式删**——
 * 替身不做级联，靠库层兜住的清理等于没被验收过（门槛 2 要的是行为）。
 * 空列表不发消息：没有洞察要死时，这一轮一条多余的写都不该有。
 */
async function deleteInsights(tx: Prisma.TransactionClient, userId: string, reflectionIds: string[]): Promise<void> {
  if (reflectionIds.length === 0) return;
  await tx.reflectionCitation.deleteMany({ where: { userId, reflectionId: { in: reflectionIds } } });
  await tx.reflectionRecord.deleteMany({ where: { userId, id: { in: reflectionIds } } });
}

/**
 * 这次对话产生的决策行（11-04 判的「2一起收」）。
 *
 * 只能顺着消息找：`DecisionRecord` 上没有 chatId，它的来源是**一条消息**（sourceMessageId 非空）。
 * 不用记忆的 sourceMessageId 凑——那条路会漏掉「抽出一句决定但没落地成记忆」的消息，
 * 而用户说的是「忘记这次对话」。
 * Message 上没有 userId，所以这一头的读取本身不分用户：把别人的 chatId 塞进来，
 * 它一样会返回那会话里的消息 id。隔离全靠下一层——`decisionRecord` 的条件始终带着 userId，
 * 别人的消息 id 牵不动我的决策，我也就不可能删掉别人的决策行。
 * 路由不校验会话归属（`memories/route.ts` 的 DELETE 只把查询串里的 chatId 原样传进来），
 * 所以「读不分用户、写按用户」这句得写在明面上，不能假装上游替我挡过了。
 * 只 select id：正文列（contentCiphertext）不经过这条路径，日志和返回值里也就没有它。
 */
async function decisionIdsByChat(tx: Prisma.TransactionClient, userId: string, chatId: string): Promise<string[]> {
  const messages = await tx.message.findMany({ where: { chatId }, select: { id: true } });
  if (messages.length === 0) return [];
  const rows = await tx.decisionRecord.findMany({
    where: { userId, sourceMessageId: { in: messages.map((message) => message.id) } },
    select: { id: true }
  });
  return rows.map((record) => record.id);
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
    // 洞察先于删记忆：等引用行被外键级联带走，就找不到「谁引用过它」了（甲 +「1算」）。
    // 这一条**不碰决策行**——「忘掉这条记忆」不是「忘记这次对话」（7.3 的两件事）。
    await deleteInsights(tx, userId, await insightIdsCiting(tx, userId, ids, []));
    const result = await tx.memoryItem.deleteMany({ where: { userId, id: { in: ids } } });
    await recordSources(tx, userId, rows);
    // 记忆没了，它留下的检索痕迹也跟着走（任务书 7.1 那张表）。按**被删的这批 id** 清，
    // 不按会话清：那张表上没有会话列，而「这一轮检索发生在哪次对话」和这里的来源会话本来也不是同一件事。
    await deleteAccessForMemories(tx, userId, ids);
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
    // 「一起收」排在「有没有记忆可删」之前，理由和撤账同一句：这一轮可能刚说完，
    // 记忆还压在队列里没跑，但这次对话已经决定了的那些选择是实打实落在这张表里的。
    const decisionIds = await decisionIdsByChat(tx, userId, chatId);
    const rows = (await tx.memoryItem.findMany({
      where: { userId, chatId }
    })) as unknown as PurgeTargetRow[];
    const ids = rows.map((row) => row.id);
    // 洞察的证据可能是这批记忆、也可能是这轮要删的决策，两样都查完再删（甲 +「1算」）。
    await deleteInsights(tx, userId, await insightIdsCiting(tx, userId, ids, decisionIds));
    if (decisionIds.length > 0) {
      await tx.decisionRecord.deleteMany({ where: { userId, id: { in: decisionIds } } });
    }
    if (rows.length === 0) return { purged: 0, contexts: [] };
    const contexts = [...new Set(rows.map((row) => fromDbMemoryContext(row.context)))];
    await detachEdges(tx, userId, ids);
    const result = await tx.memoryItem.deleteMany({ where: { userId, id: { in: ids } } });
    await recordSources(tx, userId, rows);
    // 同上：清的是这批被删记忆的检索痕迹。这一轮一行都没删到就已经返回了，不会发空写。
    await deleteAccessForMemories(tx, userId, ids);
    // 用户点的是一次按钮：删掉 5 条技术项目记忆算一条证据，不是五条，
    // 否则一次批量清理就能把阈值刷满，那不再是「反复表达同一个意思」。
    for (const context of contexts) if (recordSignals) await recordPolicySignal(tx, userId, context);
    return { purged: result.count, contexts };
  });
}

/**
 * 「忘记某个主题」（任务书 7.3 的第二臂）：删掉某个情境下的全部记忆，对话和消息一条都不动。
 *
 * 和 `purgeMemoriesByChat` 的三处不同都是刻意的，每一处都有用例钉着：
 *
 * 一、**不扫决策，也不读消息行**。决策行上没有 context，也没有 chatId，只能顺着来源消息找——
 *     而「这个主题」和「哪些消息属于它」在两列之间没有任何可对账的东西。
 *     所以主题忘记的范围到记忆、洞察和访问痕迹为止，响应文案要明说决策记录不在范围内，
 *     不能让用户以为一次主题忘记把他这轮做过的选择也清掉了。
 * 二、**不撤任何认知任务**。一条欠账是一整轮话，那一轮会落成哪几个主题还没定：
 *     按主题撤账会把同一轮里属于别的情境的说法一起抹掉，那是删用户没说要忘的东西。
 *     挡住「后台再把同一句记回来」靠的是下面那次 `recordSources`（原句一层）；
 *     挡同义改写要靠该情境的 `allowPersistence`，那是策略屏上另一个要用户另外确认的动作，
 *     不在这里替他改。
 * 三、学习证据只记这一个情境一条：删掉三条学习记忆不等于「他反复表达了三次这个意思」。
 *
 * 情境先转成库里的枚举再查，转换失败就在这儿抛——事务根本不开始，
 * 免得一个应用不认识的主题值换来一次「删了 0 行」的假成功。
 */
export async function purgeMemoriesByContext(
  context: MemoryContext,
  userId: string
): Promise<PurgeResult> {
  const dbContext = toDbMemoryContext(context);
  const recordSignals = await policyLearningEnabled(userId);
  return prisma.$transaction(async (tx) => {
    const rows = (await tx.memoryItem.findMany({
      where: { userId, context: dbContext }
    })) as unknown as PurgeTargetRow[];
    const ids = rows.map((row) => row.id);
    // 洞察先于删记忆：等引用行被外键级联带走，就找不到「谁引用过它」了（甲 +「1算」）。
    await deleteInsights(tx, userId, await insightIdsCiting(tx, userId, ids, []));
    if (rows.length === 0) return { purged: 0, contexts: [] };
    await detachEdges(tx, userId, ids);
    const result = await tx.memoryItem.deleteMany({ where: { userId, id: { in: ids } } });
    await recordSources(tx, userId, rows);
    // 清的是这批被删记忆的检索痕迹，跟「哪一轮发生在哪个会话」无关。
    await deleteAccessForMemories(tx, userId, ids);
    if (recordSignals) await recordPolicySignal(tx, userId, context);
    return { purged: result.count, contexts: [context] };
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
    // 洞察和决策按同一个范围清：「清空全部」删的是系统记住的一切，
    // 留下几条证据已经不在的洞察，等于把用户刚清掉的东西换个样子摆回他眼前（甲）。
    await tx.reflectionCitation.deleteMany({ where: { userId } });
    await tx.reflectionRecord.deleteMany({ where: { userId } });
    await tx.decisionRecord.deleteMany({ where: { userId } });
    // 访问痕迹按同一个范围清：这个用户的记忆一行不剩，留着痕迹就是留着一批指向已删内容的 id。
    await deleteAllAccess(tx, userId);
    return { purged: result.count, contexts: [] };
  });
}
