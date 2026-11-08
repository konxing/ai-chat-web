import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { CognitiveTask } from '@prisma/client';
import { decryptMessage } from '@/lib/chats';
import { log } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { MODULE_SWITCH, runCognitiveWrites, type CognitiveTurn } from './manager';
import { ensureCognitiveModules } from './memory-module';
import { getCognitivePreferences } from './preferences';
import { runReflectionSweep } from './reflection-sweep';
import { runMemoryConsolidation } from './memory-consolidator';
import { runSessionSummarySweep } from './memory-session-summary';
import { runAutoConfirmSweep } from './pending-confirmation-sweep';
import {
  claimCognitiveTasks,
  finishCognitiveTask,
  killCognitiveTask,
  retryCognitiveTask
} from './task-queue';

/**
 * CognitiveTask 的执行端（任务书 §6）。
 *
 * 这一层只管「什么时候跑、跑谁、跑完怎么收尾」，领取协议全在 task-queue.ts。
 * 它取代了原来挂在请求尾巴上的那句 `void queueCognitiveWrites(...)`：那一版进程被杀掉，
 * 这一轮的记忆就丢了；现在先欠一条账，跑成跑不上都由库里那行说了算。
 *
 * 三件事的形状不是调优出来的：
 * 一、**串行**。同一轮的去重靠任务开头那次快照（memory-module.ts 的 known 表），
 *    两个同用户的任务并发就会各快照一次「没见过」，把一句话记成两条。所以轮询发现上一轮
 *    还没跑完就直接跳过这一轮——不排队，排队会让同一批候选被领两次。
 * 二、**闸门是三值的**。用户把开关关掉 ⇒ 欠账作废（删行、不补记，11-03 定的语义）；
 *    但偏好**读不出来** ⇒ 一条都不许删，只退避重试。照搬 manager 那句「读不到当全关」，
 *    等于一次数据库抖动就把用户排着队的话全删了。
 * 三、**这一条永不 reject**。调用方是定时器，没人 await 它的返回值；模块、解密、库再怎么坏，
 *    也只能变成一条日志，不能变成 unhandledRejection 把整个服务带下去。
 */

/**
 * 后台一轮的硬截止。
 *
 * 必须严格小于 COGNITIVE_TASK_LEASE_MS：截止比租约长，任务还在跑就已经被别人领走了。
 * 60 秒租约对「解密一句话 + 十来条语句」高出几个数量级，20 秒仍然留得下整个去重池。
 */
export const COGNITIVE_TASK_TIMEOUT_MS = 20_000;

/** 轮询间隔。队列的吞吐上限远高于对话自己的限速，所以这个数只决定「最坏情况下晚几秒记上」。 */
const COGNITIVE_WORKER_POLL_MS = 2_000;

/**
 * 本进程的租约主人。leaseOwner 同时是 fencing 凭据：finish/retry/kill 的 where 里都带着它，
 * 上一任僵尸执行不能改写已经归别人的行。带上 pid 和一段随机后缀，是因为同一台机器上
 * 重启前后的两个进程不能共用一个身份——旧进程还压在写里时，它的收尾语句会被新进程的行误命中。
 */
export const COGNITIVE_WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`.slice(0, 64);

let timer: ReturnType<typeof setInterval> | undefined;
let drain: Promise<void> | undefined;

/** 到点了就跑一轮；上一轮还在跑就直接跳过——串行是正确性条件，见文件头。 */
function pollOnce(): void {
  if (drain) return;
  drain = runCognitiveWorkerTick()
    .then(
      () => undefined,
      () => {
        // 按契约这里到不了：runCognitiveWorkerTick 自己永不 reject。
        // 留着是因为调用方是定时器，真的漏出来就没人接得住。
        log.warn('cognitive.worker_tick_failed', { reason: 'unexpected' });
      }
    )
    .then(() => {
      drain = undefined;
    });
}

/**
 * 启动轮询。幂等：重复注册会让每一轮跑两遍。
 *
 * 这个函数**同步返回**，一次库都不碰——它由 Next 的 instrumentation 钩子在端口打开之前调用，
 * 在这里 await 就等于把冷启动挂在数据库上。定时器 unref，所以它永远不能独自把进程留住。
 */
export function startCognitiveWorker(): void {
  if (timer) return;
  // 模块注册表是进程内的，空表下每条任务都会「没有模块可跑」，所以先把注册补上。
  ensureCognitiveModules();
  timer = setInterval(pollOnce, COGNITIVE_WORKER_POLL_MS);
  timer.unref();
}

/** 停轮询，并等在跑的这一轮结束——之后调用方才好关数据库连接。 */
export async function stopCognitiveWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  const pending = drain;
  drain = undefined;
  if (pending) await pending;
}

/**
 * 跑一轮：领一批、一个个跑完，然后扫一遍这一轮真正做过活的用户的洞察。
 * 返回值是这一轮处理的条数，只给测试和排障看。
 */
export async function runCognitiveWorkerTick(): Promise<number> {
  try {
    const tasks = await claimCognitiveTasks(COGNITIVE_WORKER_ID);
    for (const task of tasks) await settleTask(task);
    // 反思跟着「这一轮有活的 user」走，不单独起定时器：空闲进程不该为一次扫描付钱，
    // 而 6.6 的「一天一次」由 reflection-sweep 自己那道条件 UPDATE 保证，这里只负责触发。
    // 串行 await 而不是 fire-and-forget：pollOnce 的 drain 锁就是靠「一轮跑完才进下一轮」
    // 成立的，放出去两次扫描会同时对同一个池子做 O(n²) 聚类。拖住下一批欠账的代价
    // 由扫描自己那 15 秒截止兜住。
    for (const userId of new Set(tasks.map((task) => task.userId))) {
      await runReflectionSweep(userId, { now: new Date() });
      // 巩固（Phase 3，env 默认关）：幂等——冗余条归档后下一轮就聚不出簇，不会反复动库。
      await runMemoryConsolidation(userId);
      // 会话结束总结（默认关，后台开关控制）：对话闲置够久后把这一场的碎片收拢成要点，
      // 并与其它已存记忆比对查重/查差别。一轮最多一场，碎片归档后条件自然不成立，不会重复。
      await runSessionSummarySweep(userId);
      // 待确认自动裁决（后台开关控制，默认开）：记忆候选/决策/画像建议超过 24 小时没处理时
      // 交给审核模型逐条判保留或丢弃。没有超时条目的用户一次模型都不调。
      await runAutoConfirmSweep(userId);
    }
    return tasks.length;
  } catch {
    // 只记事件名：驱动的报错原文里会带上失败的字段值。
    log.warn('cognitive.worker_tick_failed', { reason: 'claim_failed' });
    return 0;
  }
}

/** 三值闸门：这个用户还有没有任何一个认知模块开着。 */
async function gateOpen(userId: string): Promise<'on' | 'off' | 'unknown'> {
  try {
    const preferences = await getCognitivePreferences(userId);
    // 看开关表而不是看注册表：注册表是进程内的，worker 判断的是「这条欠账还该不该跑」。
    return Object.values(MODULE_SWITCH).some((flag) => preferences[flag] === true) ? 'on' : 'off';
  } catch {
    log.warn('cognitive.preferences_unavailable', { userId });
    return 'unknown';
  }
}

/**
 * 跑一条欠账。这里的每一条出口都必须给行一个归宿：删掉、退避、或者判死——
 * 留下来的行只会被下一次领取再捡起来，所以「什么都不做」不是选项。
 */
async function settleTask(task: CognitiveTask): Promise<void> {
  const gate = await gateOpen(task.userId);
  if (gate === 'unknown') {
    await retryCognitiveTask(task, COGNITIVE_WORKER_ID, 'PREFERENCES_UNAVAILABLE');
    return;
  }
  if (gate === 'off') {
    await finishCognitiveTask(task, COGNITIVE_WORKER_ID);
    log.warn('cognitive.task_discarded', {
      taskId: task.id,
      userId: task.userId,
      chatId: task.chatId,
      sourceMessageId: task.sourceMessageId,
      reason: 'switches_off'
    });
    return;
  }

  // 正文不在任务行上，从消息行解密重建。归属不能只看消息 id：Message 上没有 userId 列，
  // 隔离锚点是 Chat.userId，所以先用 (chatId, userId) 确认这个会话是这个用户的，再按会话取消息
  // ——和 chats.ts:362 送上下文出去前的那次校验是同一套，理由也一样：不能只依赖入队时做过校验。
  const owned = await prisma.chat.findFirst({
    where: { id: task.chatId, userId: task.userId },
    select: { id: true }
  });
  const source = owned
    ? await prisma.message.findFirst({ where: { id: task.sourceMessageId, chatId: owned.id } })
    : null;
  if (!source) {
    // 会话删了会级联带走消息行和这条任务行：重跑永远造不出那一轮，所以丢弃而不是重试。
    await finishCognitiveTask(task, COGNITIVE_WORKER_ID);
    log.warn('cognitive.task_source_missing', {
      taskId: task.id,
      userId: task.userId,
      chatId: task.chatId,
      sourceMessageId: task.sourceMessageId
    });
    return;
  }

  const turn: CognitiveTurn = {
    userId: task.userId,
    chatId: task.chatId,
    content: decryptMessage(source),
    sourceMessageId: task.sourceMessageId,
    occurredAt: source.createdAt
  };
  const outcome = await runCognitiveWrites(turn, COGNITIVE_TASK_TIMEOUT_MS);

  if (outcome.failed.length === 0) {
    await finishCognitiveTask(task, COGNITIVE_WORKER_ID);
    log.debug('cognitive.task_done', {
      taskId: task.id,
      userId: task.userId,
      modules: outcome.attempted
    });
    return;
  }
  // 只要有一个模块是超时，这一轮就整条判死：runCognitiveWrites 会等到超时模块真正落地才返回，
  // 但「它最后到底是写成了还是写了一半」从这里已经分不清，而重跑正是「同一句话记两条」的来源。
  // 宁可留下一行可查的 DEAD。
  if (outcome.failed.some((failure) => failure.reason === 'timeout')) {
    await killCognitiveTask(task, COGNITIVE_WORKER_ID, 'MODULE_TIMEOUT');
    log.warn('cognitive.task_timeout', { taskId: task.id, userId: task.userId });
    return;
  }
  await retryCognitiveTask(task, COGNITIVE_WORKER_ID, 'MODULE_WRITE_FAILED');
}
