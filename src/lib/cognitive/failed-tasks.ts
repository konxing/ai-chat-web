import { prisma } from '@/lib/prisma';

/**
 * 失败任务查看（任务书 §6 要求 4）。
 *
 * §6 那八条要求里，只有这一条到今天还没有读取方：`DEAD` 行确实落在库里（次数用完、超时、
 * 或租约过期后被判定不再重试），但除了直接查数据库没有任何地方能看见它。这一屏补的就是
 * 「你有些话系统没记上」——沿用这个仓库已经定过两次的立场：不说出来就等于用「看不见」冒充「没有」。
 *
 * 三条形状是这片的前提，不是调优：
 *
 * 一、**只读调度列，一个正文字段都不碰。** CognitiveTask 行里本来就没有正文（要求 8 靠的是结构，
 *    不是靠记得不打日志），查看这一屏如果把 sourceMessageId 拿去解密那句话，就等于在欠账表上
 *    新凿出一条读明文的路——那句话要看，走已有的会话页。
 *    连 sourceMessageId 本身都不端出去：会话页没有「滚到某一句」的锚点，给了坐标也点不动。
 * 二、**只回 `DEAD`。** `PENDING`（含正在退避重试）和 `RUNNING` 都不是失败。把它们端上来
 *    这一屏就变成队列仪表盘，而任务书要的是失败任务查看。
 * 三、**判死时间用 `updatedAt`。** `DEAD` 是终态：之后没有任何代码路径再改写这一行，
 *    所以最后一次更新就是被判定不再重试的那一刻。这条依赖是隐式的，写在用例里一起守着。
 */

/** 一屏最多列 50 条判死行。读 51 条只为知道有没有第 51 条，和那两份 200 行列表同一个口径。 */
export const FAILED_TASK_LIST_MAX_ROWS = 50;

/**
 * 界面上要说的五种情况。`other` 只可能来自以后新增的错误码：认不出来的码不猜原因，
 * 因为猜错的那句解释会被用户当成事实。
 */
export type FailedTaskReason =
  | 'timeout'
  | 'retry_exhausted'
  | 'lease_expired'
  | 'preferences_unavailable'
  | 'other';

export interface FailedTaskDto {
  id: string;
  /** 「去看那次对话」的落点：这一屏说不出是哪句话，但说得出它在哪次对话里。 */
  chatId: string;
  /** 被判定不再重试的那一刻，不是欠下这条账的那一刻。 */
  failedAt: string;
  /** 原样带出，不取整、不折算：界面要说的是「试过 3 次」而不是「试过好几次」。 */
  attempts: number;
  reason: FailedTaskReason;
}

/**
 * 只有这四个码是这套代码会写进 `DEAD` 行的：两个由 worker 判死（`settleTask` 的超时与写失败分支
 * 经 `retryCognitiveTask` 走到次数上限），一个由租约回收判死（`claimCognitiveTasks`）。
 * 逐个对着 task-worker.ts 与 task-queue.ts 数出来的，不是推测——少一个就会有一行被判成 `other`，
 * 而 `other` 那句「原因没有记下来」是对着一行其实记了原因的话说的假话。
 */
const REASON_BY_ERROR_CODE: Record<string, FailedTaskReason> = {
  MODULE_TIMEOUT: 'timeout',
  MODULE_WRITE_FAILED: 'retry_exhausted',
  LEASE_EXPIRED: 'lease_expired',
  PREFERENCES_UNAVAILABLE: 'preferences_unavailable'
};

export async function listFailedCognitiveTasks(
  userId: string
): Promise<{ tasks: FailedTaskDto[]; capped: boolean }> {
  const rows = await prisma.cognitiveTask.findMany({
    where: { userId, status: 'DEAD' },
    orderBy: { updatedAt: 'desc' },
    take: FAILED_TASK_LIST_MAX_ROWS + 1,
    select: {
      id: true,
      chatId: true,
      attempts: true,
      lastErrorCode: true,
      updatedAt: true
    }
  });

  const capped = rows.length > FAILED_TASK_LIST_MAX_ROWS;
  const window = capped ? rows.slice(0, FAILED_TASK_LIST_MAX_ROWS) : rows;
  return {
    tasks: window.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      failedAt: row.updatedAt.toISOString(),
      attempts: row.attempts,
      reason: REASON_BY_ERROR_CODE[row.lastErrorCode ?? ''] ?? 'other'
    })),
    capped
  };
}
