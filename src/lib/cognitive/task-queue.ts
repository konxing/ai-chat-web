import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import type { CognitiveTask, CognitiveTaskKind, Prisma } from '@prisma/client';

/**
 * CognitiveTask 队列表层（任务书 §6）。
 *
 * 这一层是**唯一**碰 `prisma.cognitiveTask` 的地方：领取协议、租约、退避、取消都收敛在这里，
 * worker 只负责「什么时候跑」和「跑谁」。
 *
 * 三件事决定了它的形状：
 * 一、行里没有正文。要重建那一轮，靠 sourceMessageId 从 Message 行解密（那句话落库时就是
 *    逐字原文），所以任务书 5.5 那条「不许出现明文」在这里是结构上违反不了的。
 * 二、并发安全靠条件 UPDATE 自身的行锁——和 memories.ts 取代旧版本用的是同一个协议，
 *    不引入 `$queryRaw`：那会把这套机制最要命的部分放到所有测试之外。
 * 三、成功即删行。这张表只装「还欠着的活」，不是历史表，所以门槛 2 里「删除要连带清理派生数据」
 *    的分母不会随使用越滚越大；完成过的痕迹只在日志里。
 */

/** 一轮最多领这么多条。吞吐上限远高于对话自己的限速，所以不需要更激进。 */
export const COGNITIVE_TASK_BATCH_SIZE = 5;
/**
 * 租约 60 秒。写侧一轮是「十来条语句 + 解密一整池候选」，60 秒比它高出几个数量级——
 * 因此不需要心跳续约这一整套机制；真正的判断依据是 docs 里的实测每任务耗时。
 */
export const COGNITIVE_TASK_LEASE_MS = 60_000;
/** 领取次数上限：第三次之后失败不再排下一次。次数在**领取时**消耗，见 claim 的注释。 */
export const COGNITIVE_TASK_MAX_ATTEMPTS = 3;
/** 第一次失败 30 秒后重试，第二次 60 秒。第三次已经是 DEAD，不存在更长的尾巴。 */
export const COGNITIVE_TASK_RETRY_BASE_MS = 30_000;

/**
 * 入队一条欠账。返回值只回答「这次是不是真的欠下了一条新账」：
 * false 包含「已经欠着了」和「写库失败」两种，调用方都不必区分——它唯一不能做的是抛错，
 * 因为此刻回答的字节已经交付完，这一轮的记忆值不值得让整条流断掉，答案是不值得。
 */
export async function enqueueCognitiveTask(input: {
  userId: string;
  chatId: string;
  sourceMessageId: string;
  kind: CognitiveTaskKind;
}): Promise<boolean> {
  try {
    await prisma.cognitiveTask.create({ data: input });
    return true;
  } catch (err) {
    // 同一条消息的同一类任务只欠一次，靠库层 @@unique([sourceMessageId, kind]) 兜（任务书 5.1）。
    if ((err as { code?: string }).code === 'P2002') {
      // 但唯一约束不看状态：DEAD 行会一直占着这把键，同一条消息永远再也欠不上账。
      // 判过死的那条被合法重放时把它重排成 PENDING（次数清零、租约清掉）；
      // 还欠着或正在跑的照旧 false。条件 UPDATE 带 status，并发下只有一个人能重排成功。
      const revived = await prisma.cognitiveTask.updateMany({
        where: { userId: input.userId, sourceMessageId: input.sourceMessageId, kind: input.kind, status: 'DEAD' },
        data: { status: 'PENDING', attempts: 0, availableAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null }
      });
      if (revived.count > 0) {
        log.warn('cognitive.task_requeued_from_dead', {
          userId: input.userId,
          chatId: input.chatId,
          sourceMessageId: input.sourceMessageId
        });
        return true;
      }
      return false;
    }
    log.warn('cognitive.task_enqueue_failed', {
      userId: input.userId,
      chatId: input.chatId,
      sourceMessageId: input.sourceMessageId,
      // 固定字符串，不是 err.message：驱动抛出的原文里会带上失败的字段值。
      reason: 'write_failed'
    });
    return false;
  }
}

/**
 * 领一批回来执行。四步，顺序不能换：
 * ① 先把没人认领完的租约收回来（否则修好了「丢」，换来「卡住」）；
 * ② 只取候选 id，不取任何数据列；
 * ③ 条件 UPDATE 抢行——那一刻还是 PENDING 的才归我，并发安全就在这一条的行锁里；
 * ④ 按 owner 读回：这一句才是竞态的答案，抢输的人读到空。
 *
 * attempts 在这里 +1 而不是失败时 +1：崩在执行半路也要占掉一次，
 * 否则一个能把进程带死的任务可以无限重试。
 *
 * 候选查询和租约回收**故意不带 userId**：worker 是调度器，这两步只读/只写调度列
 * （status、lease*、attempts、availableAt、lastErrorCode），一个用户的内容都不碰；
 * 按用户分别回收会把调度成本绑在用户数上。真正把数据读出去的路径一律带 userId。
 */
export async function claimCognitiveTasks(workerId: string): Promise<CognitiveTask[]> {
  await reclaimExpiredLeases();
  const candidates = await prisma.cognitiveTask.findMany({
    where: { status: 'PENDING', availableAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: COGNITIVE_TASK_BATCH_SIZE,
    select: { id: true }
  });
  if (candidates.length === 0) return [];

  const ids = candidates.map((candidate) => candidate.id);
  await prisma.cognitiveTask.updateMany({
    where: { id: { in: ids }, status: 'PENDING' },
    data: {
      status: 'RUNNING',
      leaseOwner: workerId,
      leaseUntil: new Date(Date.now() + COGNITIVE_TASK_LEASE_MS),
      attempts: { increment: 1 },
      lastErrorCode: null
    }
  });
  return prisma.cognitiveTask.findMany({
    where: { id: { in: ids }, status: 'RUNNING', leaseOwner: workerId }
  });
}

/** 租约过年：还有次数就回 PENDING 等下一轮，次数用完就判 DEAD。两条都不能漏。 */
async function reclaimExpiredLeases(): Promise<void> {
  const expired = { status: 'RUNNING', leaseUntil: { lt: new Date() } } as const;
  // 先判 DEAD：后一条会把所有过期行都捞走，顺序反了僵尸任务就永远死不掉。
  await prisma.cognitiveTask.updateMany({
    where: { ...expired, attempts: { gte: COGNITIVE_TASK_MAX_ATTEMPTS } },
    data: { status: 'DEAD', leaseOwner: null, leaseUntil: null, lastErrorCode: 'LEASE_EXPIRED' }
  });
  await prisma.cognitiveTask.updateMany({
    where: expired,
    data: { status: 'PENDING', leaseOwner: null, leaseUntil: null, lastErrorCode: 'LEASE_EXPIRED' }
  });
}

/**
 * 做完（或者按隐私语义作废）就删行。
 * 条件里带 status + leaseOwner：行已经被别人领走时命中 0 行，静默 no-op——
 * 上一任僵尸执行不能改写已经归别人的行，也不能因为行不在了抛 P2025。
 */
export async function finishCognitiveTask(task: CognitiveTask, workerId: string): Promise<void> {
  await prisma.cognitiveTask.deleteMany({
    where: { id: task.id, status: 'RUNNING', leaseOwner: workerId }
  });
}

/**
 * 失败退避。attempts 已达上限时不排下一次，直接 DEAD：
 * 「扛得住一次数据库抖动」是这一片的目的，「永远重试」不是。
 */
export async function retryCognitiveTask(
  task: CognitiveTask,
  workerId: string,
  errorCode: string
): Promise<void> {
  if (task.attempts >= COGNITIVE_TASK_MAX_ATTEMPTS) {
    await killCognitiveTask(task, workerId, errorCode);
    return;
  }
  await prisma.cognitiveTask.updateMany({
    where: { id: task.id, status: 'RUNNING', leaseOwner: workerId },
    data: {
      status: 'PENDING',
      availableAt: new Date(Date.now() + COGNITIVE_TASK_RETRY_BASE_MS * 2 ** (task.attempts - 1)),
      leaseOwner: null,
      leaseUntil: null,
      lastErrorCode: errorCode
    }
  });
}

/**
 * 判 DEAD，不再重试。除了次数用完，还有一个必须走这里的情形：**超时**。
 * 超时之后我们并不知道它到底写没写进去，而重跑正是「同一句话记两条」的来源，
 * 所以宁可留下一行可查的 DEAD。
 */
export async function killCognitiveTask(task: CognitiveTask, workerId: string, errorCode: string): Promise<void> {
  await prisma.cognitiveTask.updateMany({
    where: { id: task.id, status: 'RUNNING', leaseOwner: workerId },
    data: { status: 'DEAD', leaseOwner: null, leaseUntil: null, lastErrorCode: errorCode }
  });
}

/**
 * 撤销还没跑的活（门槛 2：派生数据要跟着删除走）。
 * 收事务客户端而不是自己开连接：遗忘和取消欠账必须是同一个事务里的同一件事，
 * 否则删完了记忆，事务外那条还排着队，用户看到的「忘记这次对话」会在几秒后被推翻。
 * 不给 chatId 就是按用户全撤——那是「清空全部长期记忆」的口径。
 */
export async function cancelCognitiveTasks(
  tx: Prisma.TransactionClient,
  filter: { userId: string; chatId?: string; sourceMessageId?: string }
): Promise<number> {
  const where: Prisma.CognitiveTaskWhereInput = { userId: filter.userId };
  if (filter.chatId) where.chatId = filter.chatId;
  // 「忘掉这一条」用：只撤产出这条记忆的那条消息欠的活，别动同一会话里别的记忆线索。
  if (filter.sourceMessageId) where.sourceMessageId = filter.sourceMessageId;
  const { count } = await tx.cognitiveTask.deleteMany({ where });
  return count;
}
