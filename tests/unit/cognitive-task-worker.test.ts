import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitiveTask } from '@prisma/client';
import { encryptMessage } from '@/lib/chats';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * 后台 worker（任务书 §6 的执行端）。
 *
 * 这一层只有一个职责：**什么时候跑、跑谁、跑完怎么收尾**。领取协议在 task-queue.ts，
 * 模块开关与超时在 manager.ts，所以这里的替身也只换掉「写这一轮」那一个接缝
 * （manager 用的是 partial mock，MODULE_SWITCH 与读侧仍是真实实现）。
 *
 * 钉住的四件事：
 * 一、闸门是三值的。用户把开关关掉 ⇒ 这一轮的欠账**作废**（删行、不补记，这是 11-03 定下的
 *    语义）；但偏好**读不出来** ⇒ 一条都不许删，只退避重试。照搬 manager 那句「读不到当全关」
 *    等于一次数据库抖动就把用户排队的话全删了。
 * 二、正文不在这儿存，也不在这儿造。它由 sourceMessageId 从消息行解密重建，而 Message 上没有
 *    userId 列——归属锚点是 Chat.userId，所以取消息必须先经会话行确认这个会话属于任务的用户。
 * 三、超时判 DEAD 不重试：不知道它写没写进去，重跑就是「同一句话记两条」的风险。
 * 四、串行。同一轮的去重靠的是任务开头那次快照（memory-module.ts 的 known 表），
 *    两个同用户的任务并发就会各快照一次「没见过」，把一句话记成两条。
 *
 * 边界：跑的是内存求值器不是 SQL，条件 UPDATE 的原子性、真库唯一约束与级联都不在本文件证明范围。
 */
const ctx = vi.hoisted(() => ({
  warns: [] as Array<[string, Record<string, unknown>]>
}));

const tables = new Map<string, MockTable>();

function taskTable(): MockTable {
  let table = tables.get('cognitiveTask');
  if (!table) {
    table = createTable({
      unique: [['sourceMessageId', 'kind']],
      defaults: () => ({
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: null
      })
    });
    tables.set('cognitiveTask', table);
  }
  return table;
}

function messageTable(): MockTable {
  let table = tables.get('message');
  if (!table) {
    table = createTable();
    tables.set('message', table);
  }
  return table;
}

function chatTable(): MockTable {
  let table = tables.get('chat');
  if (!table) {
    table = createTable();
    tables.set('chat', table);
  }
  return table;
}

/**
 * prisma 替身。取表的动作必须留到第一次用的时候再做：这个工厂会在 `@/lib/chats`
 * 被 import 的那一刻调用（它 import ./prisma），而那时文件里的 tables 还没初始化。
 */
vi.mock('@/lib/prisma', () => ({
  prisma: {
    get cognitiveTask() {
      return taskTable();
    },
    get message() {
      return messageTable();
    },
    get chat() {
      return chatTable();
    }
  }
}));

vi.mock('@/lib/logger', () => ({
  log: {
    debug: (event: string, fields: Record<string, unknown>) => ctx.warns.push([event, fields]),
    info: () => undefined,
    warn: (event: string, fields: Record<string, unknown>) => ctx.warns.push([event, fields]),
    error: () => undefined
  }
}));

/** 写这一轮的接缝：只有它换掉，其余（MODULE_SWITCH、读侧）走真实 manager。 */
const writes = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cognitive/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/manager')>();
  return { ...actual, runCognitiveWrites: writes };
});

const preferences = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: preferences
}));

const ensureModules = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cognitive/memory-module', () => ({
  ensureCognitiveModules: ensureModules
}));

/** 6-D 的反思扫描：这一片只钉「什么时候触发、以哪个用户触发」，扫描自己在 reflection-sweep.test.ts。 */
const reflectionSweep = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cognitive/reflection-sweep', () => ({
  runReflectionSweep: reflectionSweep
}));

const USER = 'user-a';
const OTHER = 'user-b';
const BASE = new Date('2026-11-03T08:00:00.000Z');
const SECOND = 1000;

async function worker() {
  return await import('@/lib/cognitive/task-worker');
}

/** 队里等着的活：PENDING、还没试过。领取归 task-queue 测，这里只喂给它。 */
function waiting(overrides: Record<string, unknown> = {}): Row {
  return {
    id: 'task-1',
    userId: USER,
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    kind: 'MEMORY',
    status: 'PENDING',
    attempts: 0,
    availableAt: new Date(BASE),
    leaseOwner: null,
    leaseUntil: null,
    lastErrorCode: null,
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    ...overrides
  };
}

/** 真库里的消息行：正文是密文、AAD 绑消息 id，所以只有走真实解密路径才测得到这一层。 */
function message(content: string, id = 'msg-1', overrides: Record<string, unknown> = {}) {
  const chatId = (overrides.chatId as string | undefined) ?? 'chat-1';
  // 消息行上没有 userId，归属只在会话行上。种一条消息就把它所属的会话也补上（默认归本用户），
  // 否则测的是替身漏掉的列，不是这条链路；已经显式种过会话的（越权用例）不覆盖。
  if (!chatTable().rows.has(chatId)) {
    chat(chatId, USER);
  }
  messageTable().seed({
    id,
    chatId,
    role: 'USER',
    createdAt: new Date(BASE),
    contentCiphertext: encryptMessage(content, id),
    ...overrides
  });
}

/** 会话行：Message 的归属锚点就靠这一张表（Chat.userId）。 */
function chat(id: string, userId: string) {
  chatTable().seed({ id, userId, createdAt: new Date(BASE), updatedAt: new Date(BASE) });
}

function enabled() {
  preferences.mockResolvedValue({ memoryEnabled: true, adaptiveMemoryEnabled: false });
}

function succeeded(...modules: string[]) {
  writes.mockResolvedValue({ attempted: modules, failed: [] });
}

function row(id: string): CognitiveTask {
  return taskTable().rows.get(id) as unknown as CognitiveTask;
}

function events(): string[] {
  return ctx.warns.map(([event]) => event);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  ctx.warns = [];
  // 每个用例换一批全新的表，而不是只清行：有用例直接替换表上的方法（claim_failed 那条把
  // updateMany 改成抛错），只清行的话那个替身会留给后面的用例，让它们全都「领不到任务」。
  tables.clear();
  writes.mockReset();
  preferences.mockReset();
  ensureModules.mockReset();
  reflectionSweep.mockReset();
  reflectionSweep.mockResolvedValue({ ran: true, generated: 0 });
});

describe('闸门：关掉就作废，读不出来一条都不删', () => {
  it('开关关掉 ⇒ 不跑写、删行、留下作废的痕迹', async () => {
    preferences.mockResolvedValue({ memoryEnabled: false });
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(taskTable().rows.size).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(events()).toContain('cognitive.task_discarded');
  });

  it('作废的日志里只有 id，没有那句话', async () => {
    preferences.mockResolvedValue({ memoryEnabled: false });
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(JSON.stringify(ctx.warns)).not.toMatch(/我住在杭州|contentCiphertext|message:/);
  });

  it('偏好读不出来 ⇒ 行留着退避重试，不删（一次数据库抖动不能清空用户排队的活）', async () => {
    preferences.mockRejectedValue(new Error('连接池断了'));
    taskTable().seed(waiting());

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(row('task-1')).toMatchObject({ status: 'PENDING', lastErrorCode: 'PREFERENCES_UNAVAILABLE' });
    expect((row('task-1').availableAt as Date).getTime()).toBe(BASE.getTime() + 30 * SECOND);
    expect(writes).not.toHaveBeenCalled();
  });

  it('开关打开 ⇒ 写这一轮跑一次，截止用的是后台的宽期限', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick, COGNITIVE_TASK_TIMEOUT_MS } = await worker();
    await runCognitiveWorkerTick();

    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![1]).toBe(COGNITIVE_TASK_TIMEOUT_MS);
    expect(COGNITIVE_TASK_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  it('暂停写入不是关掉模块 ⇒ 欠账照样排空、行照样删，不往队列里堆', async () => {
    preferences.mockResolvedValue({
      memoryEnabled: true,
      memoryWritePaused: true,
      adaptiveMemoryEnabled: false
    });
    succeeded('memory');
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    // 落不落库由写侧那道闸门判（memory-module），worker 只管把欠账跑完。
    // 要是这里也看暂停，欠账会一直留在表里堆着，用户恢复后一次性收到十几轮旧话。
    expect(taskTable().rows.size).toBe(0);
    expect(events()).not.toContain('cognitive.task_discarded');
    expect(events()).not.toContain('cognitive.task_timeout');
  });
});

describe('重建这一轮：任务行只有 id，正文从消息行解密、归属经会话行', () => {
  it('交回模块的那一轮和当初请求里的一字不差，时刻取消息自己的 createdAt', async () => {
    enabled();
    succeeded('memory');
    const sentAt = new Date(BASE.getTime() - 5 * SECOND);
    taskTable().seed(waiting());
    message('我下周三要出差去上海', 'msg-1', { createdAt: sentAt });

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(writes.mock.calls[0]![0]).toMatchObject({
      userId: USER,
      chatId: 'chat-1',
      sourceMessageId: 'msg-1',
      content: '我下周三要出差去上海',
      occurredAt: sentAt
    });
  });

  it('消息行不在（会话还在，那一轮的消息没了）⇒ 丢弃不重试：重跑也永远造不出那一轮', async () => {
    enabled();
    chat('chat-1', USER);
    taskTable().seed(waiting());

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(taskTable().rows.size).toBe(0);
    expect(events()).toContain('cognitive.task_source_missing');
    expect(writes).not.toHaveBeenCalled();
  });

  it('会话属于别人 ⇒ 就当没有：Message 行没有 userId，隔离锚点是 Chat.userId', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting());
    chat('chat-of-b', OTHER);
    message('我住在杭州', 'msg-1', { chatId: 'chat-of-b' });

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(taskTable().rows.size).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.warns)).not.toMatch(/我住在杭州/);
  });

  it('消息挂在别的会话里 ⇒ 取不到：只认 id 就等于把别人会话里的那句话记到本用户头上', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting());
    chat('chat-1', USER);
    messageTable().seed({
      id: 'msg-1',
      chatId: 'chat-2',
      role: 'USER',
      createdAt: new Date(BASE),
      contentCiphertext: encryptMessage('我住在杭州', 'msg-1')
    });

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(taskTable().rows.size).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('完结：成功删行、失败退避、超时判死', () => {
  it('写成功 ⇒ 删行，痕迹只在日志里（这张表只装还欠着的活）', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(taskTable().rows.size).toBe(0);
    expect(events()).toContain('cognitive.task_done');
  });

  it('写失败 ⇒ 回到 PENDING 退避，日志里只有 id 和错误码', async () => {
    enabled();
    writes.mockResolvedValue({ attempted: ['memory'], failed: [{ module: 'memory', reason: 'error' }] });
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(row('task-1')).toMatchObject({ status: 'PENDING', lastErrorCode: 'MODULE_WRITE_FAILED' });
    expect(JSON.stringify(ctx.warns)).not.toMatch(/我住在杭州/);
  });

  it('写超时 ⇒ 判 DEAD 不重试：不知道它写没写进去，重跑就是重复记忆', async () => {
    enabled();
    writes.mockResolvedValue({ attempted: ['memory'], failed: [{ module: 'memory', reason: 'timeout' }] });
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(row('task-1')).toMatchObject({ status: 'DEAD', lastErrorCode: 'MODULE_TIMEOUT' });
  });

  it('多个模块里只要有一个超时，这一轮就按超时处理（宁可留下可查的 DEAD）', async () => {
    enabled();
    writes.mockResolvedValue({
      attempted: ['memory', 'emotion'],
      failed: [
        { module: 'memory', reason: 'error' },
        { module: 'emotion', reason: 'timeout' }
      ]
    });
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(row('task-1').status).toBe('DEAD');
  });

  it('一次 tick 把领到的任务一个个跑完，绝不重叠', async () => {
    enabled();
    let inFlight = 0;
    let peak = 0;
    writes.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { attempted: ['memory'], failed: [] };
    });
    message('我住在杭州', 'msg-1');
    message('我在阿里工作', 'msg-2');
    message('我家孩子叫小满', 'msg-3');
    taskTable().seed(
      waiting(),
      waiting({ id: 'task-2', sourceMessageId: 'msg-2' }),
      waiting({ id: 'task-3', sourceMessageId: 'msg-3' })
    );

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(peak).toBe(1);
    expect(writes).toHaveBeenCalledTimes(3);
    expect(taskTable().rows.size).toBe(0);
  });
});

describe('轮询：一个定时器、不重入、停机收尾', () => {
  it('启动先把模块注册补上——否则空注册表下每条任务都「无模块可跑」', async () => {
    const { startCognitiveWorker, stopCognitiveWorker } = await worker();
    startCognitiveWorker();
    expect(ensureModules).toHaveBeenCalledTimes(1);
    await stopCognitiveWorker();
  });

  it('start 两次只有一个定时器：重复注册会让每一轮跑两遍', async () => {
    const { startCognitiveWorker, stopCognitiveWorker } = await worker();
    startCognitiveWorker();
    startCognitiveWorker();
    expect(vi.getTimerCount()).toBe(1);
    await stopCognitiveWorker();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('上一轮还没跑完时，下一个 tick 不重入', async () => {
    enabled();
    let release: () => void = () => undefined;
    writes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ attempted: ['memory'], failed: [] });
        })
    );
    taskTable().seed(waiting());
    message('我住在杭州');

    const { startCognitiveWorker, stopCognitiveWorker } = await worker();
    startCognitiveWorker();
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(writes).toHaveBeenCalledTimes(1);

    // 再走三个轮询周期：这一条还压在写里，队列不该被第二次领取碰过。
    await vi.advanceTimersByTimeAsync(6 * SECOND);
    expect(writes).toHaveBeenCalledTimes(1);

    release();
    await stopCognitiveWorker();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('停机：停轮询、等在跑的这一轮、不碰别人手里的行', async () => {
    enabled();
    let release: () => void = () => undefined;
    writes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ attempted: ['memory'], failed: [] });
        })
    );
    taskTable().seed(
      waiting(),
      waiting({ id: 'task-other', sourceMessageId: 'msg-9', status: 'RUNNING', leaseOwner: 'other-worker' })
    );
    message('我住在杭州');

    const { startCognitiveWorker, stopCognitiveWorker } = await worker();
    startCognitiveWorker();
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(writes).toHaveBeenCalledTimes(1);

    const stopping = stopCognitiveWorker();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SECOND);
    // 在跑的那一轮还没结束，停机就必须还挂着——不能丢下它去关数据库连接。
    expect(settled).toBe(false);

    release();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    // 这一轮在停机前刚好写完了，所以行删了；别人手里的行必须还是别人的。
    expect(row('task-1')).toBeUndefined();
    expect(row('task-other')).toMatchObject({ status: 'RUNNING', leaseOwner: 'other-worker' });
  });

  it('worker id 落在 64 字符以内：leaseOwner 是 VarChar(64)，超了要在写入之前就知道', async () => {
    const { COGNITIVE_WORKER_ID } = await worker();
    expect(COGNITIVE_WORKER_ID.length).toBeLessThanOrEqual(64);
    expect(COGNITIVE_WORKER_ID.length).toBeGreaterThan(0);
  });

  it('领取这一步自己炸了也不 reject：一次数据库抖动不能变成 unhandledRejection', async () => {
    enabled();
    taskTable().seed(waiting());
    // reclaimExpiredLeases 是 tick 碰库的第一步，让它炸——这是整条 tick 唯一没被
    // 单任务错误处理包住的入口，以前由 queueCognitiveWrites 在外面接住。
    taskTable().updateMany = () => Promise.reject(new Error('连接池断了'));

    const { runCognitiveWorkerTick } = await worker();
    await expect(runCognitiveWorkerTick()).resolves.toBe(0);

    expect(events()).toContain('cognitive.worker_tick_failed');
    expect(JSON.stringify(ctx.warns)).not.toContain('连接池断了');
  });
});

describe('反思扫描的触发：跟着真正跑过活的 用户走', () => {
  it('这一轮跑完了才扫，按任务上的用户触发，时刻从外面传进来', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting());
    message('我住在杭州');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(reflectionSweep).toHaveBeenCalledTimes(1);
    expect(reflectionSweep.mock.calls[0]![0]).toBe(USER);
    expect((reflectionSweep.mock.calls[0]![1] as { now: Date }).now.getTime()).toBe(BASE.getTime());
  });

  it('队里没有活 ⇒ 不扫：空闲进程不该为一次扫描付钱', async () => {
    enabled();

    const { runCognitiveWorkerTick } = await worker();
    const count = await runCognitiveWorkerTick();

    expect(count).toBe(0);
    expect(reflectionSweep).not.toHaveBeenCalled();
  });

  it('同一用户的两条欠账只触发一次扫描（成簇是 O(n²)，跑两遍没有意义）', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting({ id: 'task-1', sourceMessageId: 'msg-1' }));
    taskTable().seed(waiting({ id: 'task-2', sourceMessageId: 'msg-2' }));
    message('我住在杭州', 'msg-1');
    message('我下个月搬家', 'msg-2');

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(reflectionSweep).toHaveBeenCalledTimes(1);
  });

  it('两个用户的活 ⇒ 各扫一次，扫的是各自的用户', async () => {
    enabled();
    succeeded('memory');
    taskTable().seed(waiting({ id: 'task-a', userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1' }));
    taskTable().seed(waiting({ id: 'task-b', userId: OTHER, chatId: 'chat-2', sourceMessageId: 'msg-2' }));
    chat('chat-2', OTHER);
    message('我住在杭州', 'msg-1');
    message('我下个月搬家', 'msg-2', { chatId: 'chat-2' });

    const { runCognitiveWorkerTick } = await worker();
    await runCognitiveWorkerTick();

    expect(reflectionSweep.mock.calls.map((call) => call[0])).toEqual([USER, OTHER]);
  });
});
