import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * 失败任务查看（任务书 §6 要求 4）。
 *
 * §6 那八条要求里，前六条和第八条都在 task-queue.ts 里有承载，只有第 4 条「支持失败任务查看」
 * 到今天为止没有任何读取方：DEAD 行落在库里，但没有人能看见它。这一屏要补的就是那一句
 * 「你有些话系统没记上」——按这个仓库已经定过的立场，不说出来就等于用「看不见」冒充「没有」。
 *
 * 钉住的几件事：
 * 一、只回判死的行。待跑（PENDING）和在跑（RUNNING）不是失败，把它们端上来会让这一屏
 *    变成一个队列仪表盘，而任务书要的是「失败任务查看」。
 * 二、只回自己名下的。DEAD 行是调度行，但调度行也带着 userId 和 sourceMessageId，
 *    跨用户读等于把「谁说过话」泄露出去。
 * 三、DTO 里没有正文，服务层也不去解任何密。这张表本来就没有正文列（§6 要求 8 靠的是结构，
 *    不是靠记得不打日志），查看这一屏必须维持同一条：**从欠账能读到的只有欠账本身**。
 *    要看那句话，走已有的会话页，不在这里另开一条解密路径。
 * 四、错误码四种来自代码，第五档「其他」只可能来自以后新增的码。认不出来的码不猜原因：
 *    猜错的那句解释会被用户当成事实。
 * 五、DTO 只有五个键，而且每个键在界面上都有读者：`id` 是行的身份，`chatId` 是那句
 *    「去看那次对话」的落点，`failedAt` 和 `attempts` 是行上的两个数，`reason` 是那句解释。
 *    `sourceMessageId`、`createdAt` 不端出来：会话页没有「滚到某一句」的锚点，
 *    给了坐标也点不动，而一个点不动的坐标迟早会被当成「界面漏了这个功能」。
 */

const tables = new Map<string, MockTable>();

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

vi.mock('@/lib/prisma', () => ({ prisma: { cognitiveTask: cognitiveTask() } }));

const USER = 'user-a';
const OTHER = 'user-b';
const BASE = new Date('2026-11-05T08:00:00.000Z');
const MINUTE = 60_000;

async function service() {
  return await import('@/lib/cognitive/failed-tasks');
}

/** 直接塞行，不走 create：时间和状态都由用例说了算，特别是「判死的那一刻」。 */
function seed(overrides: Row = {}): Row {
  const row: Row = {
    id: `task-${cognitiveTask().rows.size + 1}`,
    userId: USER,
    chatId: 'chat-1',
    sourceMessageId: `msg-${cognitiveTask().rows.size + 1}`,
    kind: 'MEMORY',
    status: 'DEAD',
    attempts: 3,
    availableAt: new Date(BASE),
    leaseOwner: null,
    leaseUntil: null,
    lastErrorCode: 'MODULE_TIMEOUT',
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    ...overrides
  };
  cognitiveTask().seed(row);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  cognitiveTask().rows.clear();
});

describe('失败任务查看：只把判死的欠账端上来', () => {
  it('只回 DEAD：待跑和在跑都不算失败', async () => {
    seed({ id: 'dead-1', sourceMessageId: 'm1' });
    seed({ id: 'pending-1', sourceMessageId: 'm2', status: 'PENDING', lastErrorCode: null });
    seed({ id: 'running-1', sourceMessageId: 'm3', status: 'RUNNING', lastErrorCode: null });

    const { tasks } = await (await service()).listFailedCognitiveTasks(USER);

    expect(tasks.map((task) => task.id)).toEqual(['dead-1']);
  });

  it('只回自己名下的 DEAD：别人的判死行一条都不露', async () => {
    seed({ id: 'mine', sourceMessageId: 'm1' });
    seed({ id: 'theirs', sourceMessageId: 'm2', userId: OTHER });

    const { tasks } = await (await service()).listFailedCognitiveTasks(USER);

    expect(tasks.map((task) => task.id)).toEqual(['mine']);
  });

  it('DTO 只有那五个键：这张表没有正文列，查看这一屏也不去别处解密', async () => {
    seed({ id: 'dead-1', sourceMessageId: 'm1' });

    const { tasks } = await (await service()).listFailedCognitiveTasks(USER);

    expect(Object.keys(tasks[0]!).sort()).toEqual(['attempts', 'chatId', 'failedAt', 'id', 'reason']);
  });

  it('四种来自代码的判死原因各归一档，认不出来的那个码不猜原因', async () => {
    seed({ id: 't1', sourceMessageId: 'm1', lastErrorCode: 'MODULE_TIMEOUT' });
    seed({ id: 't2', sourceMessageId: 'm2', lastErrorCode: 'MODULE_WRITE_FAILED' });
    seed({ id: 't3', sourceMessageId: 'm3', lastErrorCode: 'LEASE_EXPIRED' });
    seed({ id: 't5', sourceMessageId: 'm5', lastErrorCode: 'PREFERENCES_UNAVAILABLE' });
    seed({ id: 't4', sourceMessageId: 'm4', lastErrorCode: 'SOMETHING_NEW' });

    const { tasks } = await (await service()).listFailedCognitiveTasks(USER);
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task.reason]));

    expect(byId).toEqual({
      t1: 'timeout',
      t2: 'retry_exhausted',
      t3: 'lease_expired',
      t5: 'preferences_unavailable',
      t4: 'other'
    });
  });

  it('判死时间新的在前：用户先看刚出的事', async () => {
    seed({ id: 'old', sourceMessageId: 'm1', updatedAt: new Date(BASE.getTime() - 30 * MINUTE) });
    seed({ id: 'new', sourceMessageId: 'm2', updatedAt: new Date(BASE.getTime() - 1 * MINUTE) });

    const { tasks } = await (await service()).listFailedCognitiveTasks(USER);

    expect(tasks.map((task) => task.id)).toEqual(['new', 'old']);
    expect(tasks[0]!.failedAt).toBe(new Date(BASE.getTime() - 1 * MINUTE).toISOString());
  });

  it('试过几次原样带出：不做「差不多」的取整', async () => {
    seed({ id: 't1', sourceMessageId: 'm1', attempts: 1 });
    seed({ id: 't2', sourceMessageId: 'm2', attempts: 3 });

    const { tasks } = await (await service()).listFailedCognitiveTasks(USER);

    expect(Object.fromEntries(tasks.map((task) => [task.id, task.attempts]))).toEqual({ t1: 1, t2: 3 });
  });

  it('读满 50 条 ⇒ capped 为真且只回 50 条：第 51 条不进这一屏', async () => {
    for (let i = 0; i < 51; i += 1) {
      seed({ id: `t${i}`, sourceMessageId: `m${i}`, updatedAt: new Date(BASE.getTime() - i * MINUTE) });
    }

    const { tasks, capped } = await (await service()).listFailedCognitiveTasks(USER);

    expect(capped).toBe(true);
    expect(tasks).toHaveLength(50);
  });

  it('没读满 ⇒ capped 为假：这句提示不在没事的时候说话', async () => {
    seed({ id: 't1', sourceMessageId: 'm1' });

    const { tasks, capped } = await (await service()).listFailedCognitiveTasks(USER);

    expect(capped).toBe(false);
    expect(tasks).toHaveLength(1);
  });

  it('一条判死都没有 ⇒ 空列表，不抛错', async () => {
    seed({ id: 'p1', sourceMessageId: 'm1', status: 'PENDING', lastErrorCode: null });

    const { tasks, capped } = await (await service()).listFailedCognitiveTasks(USER);

    expect(tasks).toEqual([]);
    expect(capped).toBe(false);
  });
});
