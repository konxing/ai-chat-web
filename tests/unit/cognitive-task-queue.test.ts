import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitiveTask } from '@prisma/client';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * CognitiveTask 队列（任务书 §6）。
 *
 * 这一片把「这一轮的认知写入」从 fire-and-forget 的 promise 变成一条落库的欠账，
 * 为的是进程被杀之后那一轮还在——旧实现自己在注释里承认会丢（manager.ts:84-86）。
 *
 * 钉住的几件事：
 * 一、这一行里没有任何正文。正文由 sourceMessageId 从 Message 行解密重建，
 *    所以任务书 5.5 那条红线在结构上违反不了：这里没有可以放正文的列。
 * 二、幂等靠库层唯一约束（sourceMessageId + kind），不靠服务层记得先查一遍（5.1）。
 * 三、领取是「条件 UPDATE 抢行 + 按 owner 读回」。attempts 在领取时 +1 而不是失败时 +1：
 *    崩在执行半路也要占掉一次，否则能把进程带死的任务可以无限重试。
 * 四、租约过期要能回收，否则修好了「丢」却换来「卡住」。
 * 五、每一次完结写入都带 leaseOwner：上一任僵尸执行改不动已经被别人领走的行。
 * 六、取消任务同时带 userId 和 chatId——别人的行一条都不许碰。
 *
 * 边界，照旧如实说：这里跑的是内存求值器不是 SQL。条件 UPDATE 的原子性靠真库行锁，
 * mock 换来的是协议形状；真实唯一约束、外键级联、索引是否被用到，都不在本文件的证明范围。
 */
const db = vi.hoisted(() => ({
  warns: [] as Array<[string, Record<string, unknown>]>
}));

const tables = new Map<string, MockTable>();

/**
 * 表在模块加载时就建好，vi.mock 的工厂函数是惰性的，所以这里可以直接用夹具。
 *
 * defaults 照 prisma/schema.prisma 的 CognitiveTask 逐列抄：`@default(PENDING)`、
 * `@default(0)`、`@default(now())`，加上三个没有默认值的可空列（真库给 null）。
 * 抄漏一列，下面「新行是 PENDING」和「availableAt 在未来就不领」就都在测替身。
 */
function cognitiveTask(): MockTable {
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

vi.mock('@/lib/prisma', () => ({
  prisma: { cognitiveTask: cognitiveTask() }
}));

vi.mock('@/lib/logger', () => ({
  log: {
    debug: () => undefined,
    info: () => undefined,
    warn: (event: string, fields: Record<string, unknown>) => {
      db.warns.push([event, fields]);
    },
    error: () => undefined
  }
}));

const USER = 'user-a';
const OTHER = 'user-b';
const BASE = new Date('2026-11-03T08:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;

async function queue() {
  return await import('@/lib/cognitive/task-queue');
}

/** cancelCognitiveTasks 收的是事务客户端：它必须能跑在遗忘的那个事务里。 */
function client() {
  return { cognitiveTask: cognitiveTask() };
}

function seeded(overrides: Partial<CognitiveTask> = {}): CognitiveTask {
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
  } as CognitiveTask;
}

/** 内存表里的行就是任务行，取出来直接当 CognitiveTask 用（这份夹具只放这些列）。 */
function taskRow(id: string): CognitiveTask {
  return cognitiveTask().rows.get(id) as unknown as CognitiveTask;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  db.warns = [];
  cognitiveTask().rows.clear();
});

describe('入队：这一轮欠着一条认知写入', () => {
  it('写进去的行只有 id 和调度列，没有任何正文列', async () => {
    const { enqueueCognitiveTask } = await queue();

    await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });

    const row = [...cognitiveTask().rows.values()][0]!;
    expect(Object.keys(row).sort()).toEqual([
      'attempts',
      'availableAt',
      'chatId',
      'createdAt',
      'id',
      'kind',
      'lastErrorCode',
      'leaseOwner',
      'leaseUntil',
      'sourceMessageId',
      'status',
      'updatedAt',
      'userId'
    ]);
    // 显式钉一次：将来谁想加一列「顺手存下正文」，这条会先红。
    expect(JSON.stringify(row)).not.toMatch(/content|payload|text|我住在杭州/);
  });

  it('新行是 PENDING、attempts 0、立即可领', async () => {
    const { enqueueCognitiveTask } = await queue();

    await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });

    expect(cognitiveTask().rows.values().next().value).toMatchObject({
      userId: USER,
      chatId: 'chat-1',
      sourceMessageId: 'msg-1',
      kind: 'MEMORY',
      status: 'PENDING',
      attempts: 0,
      leaseOwner: null,
      lastErrorCode: null
    });
  });

  it('同一句话重复入队只欠一次：库层唯一约束挡住，返回 false 而不是抛错', async () => {
    const { enqueueCognitiveTask } = await queue();

    const first = await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });
    const second = await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });

    expect([first, second]).toEqual([true, false]);
    expect(cognitiveTask().rows.size).toBe(1);
  });

  /**
   * 唯一约束不看状态：DEAD 行一直占着 (sourceMessageId, kind) 这把键，同一条消息被合法重放时
   * 会静默丢账。判过死的行在重放时重排成 PENDING、次数清零，而不是新建第二条。
   */
  it('撞上的行已经判 DEAD：重排成 PENDING 而不是静默丢账', async () => {
    cognitiveTask().seed(
      seeded({ status: 'DEAD', attempts: 3, lastErrorCode: 'MODULE_TIMEOUT', leaseOwner: 'worker-x', leaseUntil: new Date(BASE) })
    );
    const { enqueueCognitiveTask } = await queue();

    const requeued = await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });

    expect(requeued).toBe(true);
    expect(cognitiveTask().rows.size).toBe(1);
    expect(taskRow('task-1')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      lastErrorCode: null,
      availableAt: new Date(BASE)
    });
    expect(db.warns.map(([event]) => event)).toContain('cognitive.task_requeued_from_dead');
  });

  it('撞上的行还在 PENDING/RUNNING：照旧 false，不去动别人的活', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', attempts: 1, leaseOwner: 'worker-x' }));
    const { enqueueCognitiveTask } = await queue();

    const requeued = await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });

    expect(requeued).toBe(false);
    expect(taskRow('task-1')).toMatchObject({ status: 'RUNNING', attempts: 1, leaseOwner: 'worker-x' });
  });

  it('入队本身出错不外抛：调用方是刚把回答交付完的对话链路', async () => {
    cognitiveTask().create = () => Promise.reject(new Error('数据库连接断了'));
    const { enqueueCognitiveTask } = await queue();

    await expect(
      enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' })
    ).resolves.toBe(false);
  });

  it('入队失败的日志里只有 id，没有报错原文', async () => {
    cognitiveTask().create = () => Promise.reject(new Error('插入失败：我住在杭州'));
    const { enqueueCognitiveTask } = await queue();

    await enqueueCognitiveTask({ userId: USER, chatId: 'chat-1', sourceMessageId: 'msg-1', kind: 'MEMORY' });

    expect(db.warns.map(([event]) => event)).toContain('cognitive.task_enqueue_failed');
    const [, fields] = db.warns.find(([event]) => event === 'cognitive.task_enqueue_failed')!;
    expect(Object.keys(fields).sort()).toEqual(['chatId', 'reason', 'sourceMessageId', 'userId']);
    expect(JSON.stringify(fields)).not.toContain('我住在杭州');
  });
});

describe('领取：条件 UPDATE 抢行，抢到的才归我', () => {
  it('availableAt 还在未来的不领——那是正在退避的，不是没人做的', async () => {
    cognitiveTask().seed(
      seeded({ id: 'later', availableAt: new Date(BASE.getTime() + 30 * SECOND) }),
      seeded({ id: 'now', sourceMessageId: 'msg-2', availableAt: new Date(BASE.getTime() - 1 * SECOND) })
    );
    const { claimCognitiveTasks } = await queue();

    const claimed = await claimCognitiveTasks('worker-1');

    expect(claimed.map((task: CognitiveTask) => task.id)).toEqual(['now']);
  });

  it('最旧的先领，一批封顶 5 条', async () => {
    for (let i = 0; i < 7; i += 1) {
      cognitiveTask().seed(
        seeded({
          id: `task-${i}`,
          sourceMessageId: `msg-${i}`,
          createdAt: new Date(BASE.getTime() + i * SECOND)
        })
      );
    }
    const { claimCognitiveTasks } = await queue();

    const claimed = await claimCognitiveTasks('worker-1');

    expect(claimed).toHaveLength(5);
    expect(claimed.map((task: CognitiveTask) => task.id)).toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-4']);
  });

  it('抢到之后行变成 RUNNING，带上 owner、租约和一个尝试次数', async () => {
    cognitiveTask().seed(seeded());
    const { claimCognitiveTasks } = await queue();

    const [claimed] = await claimCognitiveTasks('worker-1');

    expect(claimed).toMatchObject({ id: 'task-1', status: 'RUNNING', leaseOwner: 'worker-1', attempts: 1 });
    expect(claimed!.leaseUntil).toBeInstanceOf(Date);
    expect((claimed!.leaseUntil as Date).getTime()).toBeGreaterThan(BASE.getTime());
  });

  it('连着领两次，第二次拿到空：同一行不能被两个执行同时握着', async () => {
    cognitiveTask().seed(seeded());
    const { claimCognitiveTasks } = await queue();

    const first = await claimCognitiveTasks('worker-1');
    const second = await claimCognitiveTasks('worker-2');

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(taskRow('task-1').leaseOwner).toBe('worker-1');
  });

  it('DEAD 的行不再被领：次数用完的活要留在库里可查，但不能无限重跑', async () => {
    cognitiveTask().seed(seeded({ status: 'DEAD' }));
    const { claimCognitiveTasks } = await queue();

    expect(await claimCognitiveTasks('worker-1')).toEqual([]);
  });

  it('别人的任务也照样被领：候选查询只按调度列筛，worker 不区分用户', async () => {
    cognitiveTask().seed(seeded({ userId: OTHER }));
    const { claimCognitiveTasks } = await queue();

    const claimed = await claimCognitiveTasks('worker-1');

    expect(claimed.map((task: CognitiveTask) => task.userId)).toEqual([OTHER]);
  });
});

describe('租约过期要回收，否则「不丢」换成「卡住」', () => {
  it('租约过年且还有次数：回到 PENDING 等下一轮，次数不再重复加', async () => {
    cognitiveTask().seed(
      seeded({ status: 'RUNNING', leaseOwner: 'dead-worker', attempts: 1, leaseUntil: new Date(BASE.getTime() - 1 * SECOND) })
    );
    const { claimCognitiveTasks } = await queue();

    const claimed = await claimCognitiveTasks('worker-1');

    expect(claimed.map((task: CognitiveTask) => task.id)).toEqual(['task-1']);
    expect(claimed[0]).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 2 });
  });

  it('租约过年且次数用完：判 DEAD，标 LEASE_EXPIRED，不再被领', async () => {
    cognitiveTask().seed(
      seeded({ status: 'RUNNING', leaseOwner: 'dead-worker', attempts: 3, leaseUntil: new Date(BASE.getTime() - 1 * SECOND) })
    );
    const { claimCognitiveTasks } = await queue();

    expect(await claimCognitiveTasks('worker-1')).toEqual([]);
    expect(taskRow('task-1')).toMatchObject({ status: 'DEAD', lastErrorCode: 'LEASE_EXPIRED' });
    expect(taskRow('task-1').leaseOwner).toBeNull();
  });

  it('租约还没到期的 RUNNING 不回收：正在做的那一轮不能被打断', async () => {
    cognitiveTask().seed(
      seeded({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 1, leaseUntil: new Date(BASE.getTime() + MINUTE) })
    );
    const { claimCognitiveTasks } = await queue();

    expect(await claimCognitiveTasks('worker-2')).toEqual([]);
    expect(taskRow('task-1').status).toBe('RUNNING');
  });
});

describe('完结：三条路径都带 owner，僵尸执行改不动已被领走的行', () => {
  it('做完就删行：这张表只装还欠着的活', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 1 }));
    const { finishCognitiveTask } = await queue();

    await finishCognitiveTask(taskRow('task-1'), 'worker-1');

    expect(cognitiveTask().rows.size).toBe(0);
  });

  it('失败退避：回到 PENDING、availableAt 推到 30 秒后、只留错误码', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 1 }));
    const { retryCognitiveTask } = await queue();

    await retryCognitiveTask(taskRow('task-1'), 'worker-1', 'MEMORY_WRITE_FAILED');

    expect(taskRow('task-1')).toMatchObject({ status: 'PENDING', lastErrorCode: 'MEMORY_WRITE_FAILED' });
    expect((taskRow('task-1').availableAt as Date).getTime()).toBe(BASE.getTime() + 30 * SECOND);
    expect(taskRow('task-1').leaseOwner).toBeNull();
  });

  it('退避按次数翻倍：第一次失败 30 秒后，第二次 60 秒后', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 2 }));
    const { retryCognitiveTask } = await queue();

    await retryCognitiveTask(taskRow('task-1'), 'worker-1', 'X');

    expect((taskRow('task-1').availableAt as Date).getTime()).toBe(BASE.getTime() + 60 * SECOND);
    // 第三次已经是 DEAD（下面那条用例守着），所以这里不再排第三次退避，
    // 也就不存在需要封顶的长尾——留着一条永远走不到的上限分支只是看起来周全。
  });

  it('次数用完的失败直接判 DEAD，不再排下一次', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 3 }));
    const { retryCognitiveTask } = await queue();

    await retryCognitiveTask(taskRow('task-1'), 'worker-1', 'MEMORY_WRITE_FAILED');

    expect(taskRow('task-1')).toMatchObject({ status: 'DEAD', lastErrorCode: 'MEMORY_WRITE_FAILED' });
  });

  it('超时判 DEAD 不重试：不知道它到底写没写进去，重跑就是重复记忆的风险', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-1', attempts: 1 }));
    const { killCognitiveTask } = await queue();

    await killCognitiveTask(taskRow('task-1'), 'worker-1', 'TASK_TIMEOUT');

    expect(taskRow('task-1')).toMatchObject({ status: 'DEAD', lastErrorCode: 'TASK_TIMEOUT' });
  });

  it('行已经被别人领走时，上一任的完结写入命中 0 行、什么也不改', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-2', attempts: 2 }));
    const { retryCognitiveTask, finishCognitiveTask } = await queue();
    const stale = taskRow('task-1');

    await finishCognitiveTask(stale, 'worker-1');
    await retryCognitiveTask(stale, 'worker-1', 'TOO_LATE');

    expect(cognitiveTask().rows.size).toBe(1);
    expect(taskRow('task-1')).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-2' });
    expect(taskRow('task-1').lastErrorCode).toBeNull();
  });

  it('行已经不在了（会话被删，级联带走）时静默 no-op，不抛 P2025', async () => {
    const { finishCognitiveTask, retryCognitiveTask, killCognitiveTask } = await queue();
    const gone = seeded({ id: 'task-ghost' });

    await expect(finishCognitiveTask(gone, 'worker-1')).resolves.toBeUndefined();
    await expect(retryCognitiveTask(gone, 'worker-1', 'X')).resolves.toBeUndefined();
    await expect(killCognitiveTask(gone, 'worker-1', 'X')).resolves.toBeUndefined();
  });
});

describe('取消：遗忘和重置要能撤销还没跑的活', () => {
  it('按会话取消同时带 userId 和 chatId，别人的同会话行一条不碰', async () => {
    cognitiveTask().seed(
      seeded({ id: 'mine-1', chatId: 'chat-1' }),
      seeded({ id: 'mine-2', chatId: 'chat-1', sourceMessageId: 'msg-2' }),
      seeded({ id: 'other', userId: OTHER, chatId: 'chat-1', sourceMessageId: 'msg-3' }),
      seeded({ id: 'elsewhere', chatId: 'chat-2', sourceMessageId: 'msg-4' })
    );
    const { cancelCognitiveTasks } = await queue();

    const purged = await cancelCognitiveTasks(client() as never, { userId: USER, chatId: 'chat-1' });

    expect(purged).toBe(2);
    expect([...cognitiveTask().rows.keys()].sort()).toEqual(['elsewhere', 'other']);
  });

  it('不带 chatId 就是按用户全撤（清空全部长期记忆走这条）', async () => {
    cognitiveTask().seed(
      seeded({ id: 'a-1', chatId: 'chat-1' }),
      seeded({ id: 'a-2', chatId: 'chat-2', sourceMessageId: 'msg-2' }),
      seeded({ id: 'b-1', userId: OTHER, sourceMessageId: 'msg-3' })
    );
    const { cancelCognitiveTasks } = await queue();

    expect(await cancelCognitiveTasks(client() as never, { userId: USER })).toBe(2);
    expect([...cognitiveTask().rows.keys()]).toEqual(['b-1']);
  });

  it('RUNNING 的行也一起撤：遗忘不该等这一轮做完', async () => {
    cognitiveTask().seed(seeded({ status: 'RUNNING', leaseOwner: 'worker-1' }));
    const { cancelCognitiveTasks } = await queue();

    expect(await cancelCognitiveTasks(client() as never, { userId: USER, chatId: 'chat-1' })).toBe(1);
  });
});
