import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createTable, type MockTable } from './prisma-mock';

/**
 * 检索访问记录（任务书 7.1「记忆被再次调用时」的那次调用，今天得先成为一件事实）。
 *
 * 这一片唯一的目标是**把「这一轮哪几条记忆真进了提示词」记下来**。形状上的三个选择都不是审美：
 *
 * 一、**一轮一行，不在 MemoryItem 上加 accessCount/lastRetrievedAt。**
 * 一轮最多注入 8 条（memory-module.ts:44），列在行上意味着每轮 8 次 UPDATE，
 * 更糟的是访问列会和 `assessConfidence` 已经在读的那一行（supersededAt、validTo）长在一起——
 * 那条「检索次数不能直接提高事实可信度」的红线就从结构约束退化成一句自觉。
 * 分行放，置信度的输入里根本拿不到访问这个东西。
 *
 * 二、**行里只有 id，没有正文。** 抄 CognitiveTask 那张表的口径（schema.prisma:629-636）：
 * 「没有可以放正文的列」比「我们承诺不放正文」难违反得多。
 *
 * 三、**幂等锚点是 sourceMessageId。** 同一条消息重发（网络重试、用户按两下）不该记成两次访问，
 * 否则「被带到 3 次」里有一多半是重试。库层唯一约束兜，不靠服务层先查（任务书 5.1）。
 *
 * 写入永不抛：此刻 SSE 的字节已经交付完（messages/route.ts 的 close() 之后），
 * 一轮的记忆值不值得把整条流断掉，答案是不值得——这条契约照抄 enqueueCognitiveTask（task-queue.ts:32-36）。
 *
 * 边界照旧如实说：跑的是内存求值器不是 SQL。唯一约束的真实行为、`(userId, createdAt)` 索引
 * 是否被用到，不在本文件的证明范围里。
 */
const logs = vi.hoisted(() => ({ warns: [] as Array<[string, Record<string, unknown>]> }));

const tables = new Map<string, MockTable>();

function memoryAccessTurn(): MockTable {
  let table = tables.get('memoryAccessTurn');
  if (!table) {
    table = createTable({
      unique: [['sourceMessageId']]
    });
    tables.set('memoryAccessTurn', table);
  }
  return table;
}

/** 证据表：本文件只用它读置信度那一条行为证明，所以行是测试自己塞的，不走 recordEvidence。 */
function memoryEvidence(): MockTable {
  let table = tables.get('memoryEvidence');
  if (!table) {
    table = createTable();
    tables.set('memoryEvidence', table);
  }
  return table;
}

function evidenceRow(memoryId: string, kind: string, id: string) {
  return { id, userId: USER, memoryId, kind };
}

const tx = { memoryAccessTurn: memoryAccessTurn(), memoryEvidence: memoryEvidence() };

vi.mock('@/lib/prisma', () => ({
  prisma: {
    memoryAccessTurn: memoryAccessTurn(),
    // 置信度那条行为证明要读证据表；这张表在替身里只用到 groupBy。
    memoryEvidence: memoryEvidence(),
    $transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)
  }
}));
vi.mock('@/lib/logger', () => ({
  log: {
    warn: (event: string, fields: Record<string, unknown>) => logs.warns.push([event, fields]),
    error: () => undefined,
    info: () => undefined
  }
}));

const USER = 'user-a';
const OTHER = 'user-b';

async function access() {
  return await import('@/lib/cognitive/access');
}

function record(input: {
  userId: string;
  sourceMessageId: string;
  memoryIds: readonly string[];
}) {
  return access().then(({ recordMemoryAccess }) => recordMemoryAccess(input));
}

/**
 * 三个删除动作的真实调用方在事务里（forgetting.ts 的三条 purge），所以用例也要走事务的形状：
 * 替身把 $transaction 展开成同一个表对象，这样「tx 上的删除」和「prisma 上的读取」看到的是同一份行。
 * prisma 在这里惰性 import：顶层 import 会让 vi.mock 的工厂在 `tables` 初始化之前就被调用。
 */
async function inTx<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const { prisma } = await import('@/lib/prisma');
  return prisma.$transaction(run) as Promise<T>;
}

/**
 * 夹具的 create 会被「写库抛错」那两条用例临时换成一个永远 reject 的桩，
 * 必须在每条用例开始前换回来——不换的话后面每条 record 都在往桩上写，
 * 测到的就不再是实现。这种泄漏是夹具的坑，不是被测代码的坑，所以在这里收口。
 */
const pristineCreate = memoryAccessTurn().create;

beforeEach(() => {
  const table = memoryAccessTurn();
  table.create = pristineCreate;
  table.rows.clear();
  memoryEvidence().rows.clear();
  logs.warns.length = 0;
});

describe('记录一次检索访问', () => {
  it('这一轮没带任何记忆就不写行，返回 false', async () => {
    await expect(record({ userId: USER, sourceMessageId: 'm-1', memoryIds: [] })).resolves.toBe(false);

    expect(memoryAccessTurn().rows.size).toBe(0);
  });

  it('一轮注入 8 条只写一行，而且这一行里只有 id', async () => {
    const ids = ['mem-1', 'mem-2', 'mem-3', 'mem-4', 'mem-5', 'mem-6', 'mem-7', 'mem-8'];

    await expect(
      record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ids })
    ).resolves.toBe(true);

    const [row] = [...memoryAccessTurn().rows.values()];
    expect(row?.memoryIds).toEqual(ids);
    // 夹具会替真库补一个本表没有的 updatedAt，所以这里断的是「一个多余的键都不许多」。
    // 没有 chatId 也在这一条里：这一轮发生在哪次对话，等于 sourceMessageId 那条消息所在的会话。
    expect(Object.keys(row!).sort()).toEqual(
      ['createdAt', 'id', 'memoryIds', 'sourceMessageId', 'updatedAt', 'userId'].sort()
    );
  });

  it('同一条消息重发不起第二行，返回 false（库层唯一约束挡的，不是服务层记得查）', async () => {
    await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });

    await expect(record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] })).resolves.toBe(false);

    expect(memoryAccessTurn().rows.size).toBe(1);
  });

  it('写库抛错也只返回 false，不把调用方带下水', async () => {
    const table = memoryAccessTurn();
    table.create = () => Promise.reject(new Error('driver exploded with 我住在杭州 in it'));

    await expect(record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] })).resolves.toBe(false);
  });

  it('写库失败时日志只带 id 与固定 reason，不带报错原文也不带记忆正文', async () => {
    const table = memoryAccessTurn();
    table.create = () => Promise.reject(new Error('driver exploded with 我住在杭州 in it'));

    await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });

    expect(logs.warns).toHaveLength(1);
    const [event, fields] = logs.warns[0]!;
    expect(event).toBe('cognitive.access_write_failed');
    expect(fields.reason).toBe('write_failed');
    expect(JSON.stringify(fields)).not.toContain('我住在杭州');
    expect(JSON.stringify(fields)).not.toContain('exploded');
  });
});

describe('统计访问', () => {
  it('按记忆条数：进了三轮的记忆算 3 次，最后一轮的时间留得下来', async () => {
    const { listAccessStats } = await access();
    await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1', 'mem-2'] });
    await record({ userId: USER, sourceMessageId: 'm-2', memoryIds: ['mem-1'] });
    await record({ userId: USER, sourceMessageId: 'm-3', memoryIds: ['mem-1', 'mem-3'] });

    const stats = await listAccessStats(USER);

    expect(stats.byMemory.get('mem-1')).toMatchObject({ count: 3 });
    expect(stats.byMemory.get('mem-2')?.count).toBe(1);
    expect(stats.byMemory.get('mem-3')?.count).toBe(1);
    expect(stats.scannedTurns).toBe(3);
    expect(stats.capped).toBe(false);
    expect(stats.byMemory.get('mem-1')?.lastAt).toBeTypeOf('string');
  });

  it('别人的轮次一条也不进来', async () => {
    const { listAccessStats } = await access();
    await record({ userId: OTHER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });

    const stats = await listAccessStats(USER);

    expect(stats.byMemory.size).toBe(0);
    expect(stats.scannedTurns).toBe(0);
  });

  it('只读最近 200 轮，多出来的算不到但 capped 要说实话', async () => {
    const { MEMORY_ACCESS_MAX_ROWS, listAccessStats } = await access();
    // 先记一条 mem-new 再灌满：它必须落在窗口之外的**最旧**那一侧，不然这条测的是排序不是截断。
    await record({ userId: USER, sourceMessageId: 'm-early', memoryIds: ['mem-new'] });
    for (let index = 0; index < MEMORY_ACCESS_MAX_ROWS + 5; index += 1) {
      await record({ userId: USER, sourceMessageId: `m-${index}`, memoryIds: ['mem-old'] });
    }

    const stats = await listAccessStats(USER);

    expect(stats.scannedTurns).toBe(MEMORY_ACCESS_MAX_ROWS);
    expect(stats.capped).toBe(true);
    expect(stats.byMemory.get('mem-old')?.count).toBe(MEMORY_ACCESS_MAX_ROWS);
    expect(stats.byMemory.has('mem-new')).toBe(false);
  });

  it('lastAt 是这一条最后一次出现的那一轮，不是全局最后一轮', async () => {
    const { listAccessStats } = await access();
    const first = await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });
    expect(first).toBe(true);
    await record({ userId: USER, sourceMessageId: 'm-2', memoryIds: ['mem-2'] });
    await record({ userId: USER, sourceMessageId: 'm-3', memoryIds: ['mem-2'] });

    const stats = await listAccessStats(USER);
    const mine = stats.byMemory.get('mem-1')!;

    expect(mine.count).toBe(1);
    expect(new Date(mine.lastAt).getTime()).toBeLessThan(new Date(stats.byMemory.get('mem-2')!.lastAt).getTime());
  });
});

/**
 * 这三个删除动作只有一个调用方：forgetting.ts 的三条 purge，而它们跑在事务里。
 * 所以签名收的是事务客户端（照 cancelCognitiveTasks / recordExclusions 的形状），
 * 「记忆行删掉了而访问行还在」这种半截状态必须在结构上不存在。
 */
describe('这条表归忘记动作管', () => {
  it('按记忆删：只出现在这些记忆上的轮次整行走，别的行留着', async () => {
    const { deleteAccessForMemories, listAccessStats } = await access();
    await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });
    await record({ userId: USER, sourceMessageId: 'm-2', memoryIds: ['mem-2'] });

    const removed = await inTx((tx) => deleteAccessForMemories(tx, USER, ['mem-1']));

    expect(removed).toBe(1);
    expect((await listAccessStats(USER)).byMemory.has('mem-1')).toBe(false);
    expect((await listAccessStats(USER)).byMemory.has('mem-2')).toBe(true);
  });

  it('按记忆删要连别人的行挡掉：id 撞上了也不许删别人的那一轮', async () => {
    const { deleteAccessForMemories } = await access();
    await record({ userId: OTHER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });

    await expect(inTx((tx) => deleteAccessForMemories(tx, USER, ['mem-1']))).resolves.toBe(0);

    expect(memoryAccessTurn().rows.size).toBe(1);
  });

  it('按记忆删是整行删，不是把那个 id 从数组里挑出来', async () => {
    const { deleteAccessForMemories, listAccessStats } = await access();
    // 那一轮同时带了 mem-1 和 mem-2。删掉 mem-1 之后这一轮整行消失，mem-2 的条数跟着少 1。
    // 挑着删等于让一条已删除记忆的 id 继续留在库里——那个 id 本身就是被删内容的痕迹。
    await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1', 'mem-2'] });

    await expect(inTx((tx) => deleteAccessForMemories(tx, USER, ['mem-1']))).resolves.toBe(1);

    expect(memoryAccessTurn().rows.size).toBe(0);
    expect((await listAccessStats(USER)).byMemory.size).toBe(0);
  });

  it('会话被删时这一行靠 sourceMessageId 那条外键自己走：这张表上不留 chatId', () => {
    // 这一条是结构断言，不是行为断言。之前这里有个 deleteAccessForChat，判它没有消费者：
    // 「忘记这次对话产生的记忆」里的 chatId 是记忆的**来源**会话，
    // 而「这一轮发生在哪次对话」是 sourceMessageId 那条消息所在的会话，两个集合不是一回事，
    // 用后者去删会把别的对话里正常发生的检索抹掉；真的删会话时那条外键是 CASCADE，消息一走这一行自己就走。
    const block = modelBlock('MemoryAccessTurn');
    expect(block).toMatch(/sourceMessage\s+Message\s+@relation\([^)]*onDelete:\s*Cascade/);
    expect(block).not.toMatch(/chatId/);
  });

  it('清空全部：这个用户的行全走，别人的留着', async () => {
    const { deleteAllAccess } = await access();
    await record({ userId: USER, sourceMessageId: 'm-1', memoryIds: ['mem-1'] });
    await record({ userId: USER, sourceMessageId: 'm-2', memoryIds: ['mem-2'] });
    await record({ userId: OTHER, sourceMessageId: 'm-3', memoryIds: ['mem-3'] });

    await expect(inTx((tx) => deleteAllAccess(tx, USER))).resolves.toBe(2);

    expect(memoryAccessTurn().rows.size).toBe(1);
  });

  it('空 id 列表不做任何事，不抛：忘记一条记忆时库里可能本来就一笔痕迹都没有', async () => {
    const { deleteAccessForMemories } = await access();

    await expect(inTx((tx) => deleteAccessForMemories(tx, USER, []))).resolves.toBe(0);
  });
});

/**
 * 任务书 7.1：「检索次数不能直接提高事实可信度。访问频率只能影响检索排序，不能替代证据。」
 *
 * 这条不能只写在注释里。上面那组静态守卫管住的是「访问进不了置信度的输入」，
 * 这里管的是算出来的结果：**访问从 0 次涨到 60 次，置信度的每个字节都不许动**。
 * 底下那条正向对照是这条断言的说明书——如果加一条真的证据也 change 不了输出，
 * 那上一条就是在测一台什么都没接上的机器。
 */
describe('访问不改变置信度（行为证明）', () => {
  const subject = [{ id: 'mem-1', origin: 'explicit' as const, confirmedAt: null, supersededAt: null, validTo: null }];

  async function assess() {
    const { assessMemories } = await import('@/lib/cognitive/evidence');
    return JSON.stringify([...(await assessMemories(USER, subject))]);
  }

  it('同一批证据：0 次访问与 60 次访问算出的置信度逐字节相同', async () => {
    memoryEvidence().seed(evidenceRow('mem-1', 'SUPPORTS', 'ev-1'), evidenceRow('mem-1', 'SUPPORTS', 'ev-2'));
    const withoutAccess = await assess();

    for (let index = 0; index < 60; index += 1) {
      await record({ userId: USER, sourceMessageId: `m-${index}`, memoryIds: ['mem-1'] });
    }
    expect(memoryAccessTurn().rows.size).toBe(60);

    expect(await assess()).toBe(withoutAccess);
  });

  it('正向对照：多一条真的支持证据会变——说明上一条测的是同一个函数', async () => {
    memoryEvidence().seed(evidenceRow('mem-1', 'SUPPORTS', 'ev-1'));
    const before = await assess();

    memoryEvidence().seed(evidenceRow('mem-1', 'SUPPORTS', 'ev-2'));

    expect(await assess()).not.toBe(before);
  });
});

/** 取出 schema 里某个 model 的整块（含它自己的字段注释）。 */
function modelBlock(name: string): string {
  const schema = readFileSync(resolve(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const lines = schema.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`model ${name} {`));
  expect(start, `schema 里没有 model ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return lines.slice(start, end + 1).join('\n');
}

/**
 * 「检索次数不能直接提高事实可信度」这一条不能只写在注释里。
 * 下面三条把它变成结构：访问表里没有可以放正文的列、访问计数不在 MemoryItem 那一行上、
 * 算置信度和挑记忆的那四个文件根本不认识访问模块。任何一条被后来的人绕过，这里就红。
 */
describe('访问与置信度的隔离（结构守卫）', () => {
  it('这张表里没有正文列：没有密文、没有 Text，也没有内容字样', () => {
    const block = modelBlock('MemoryAccessTurn');
    for (const forbidden of ['Ciphertext', '@db.Text', 'content', 'note']) {
      expect(block, `访问表里不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('访问计数不放在 MemoryItem 上——那一行正是 assessConfidence 在读的列', () => {
    const block = modelBlock('MemoryItem');
    for (const forbidden of ['accessCount', 'lastRetrievedAt', 'retrievalCount', 'MemoryAccessTurn']) {
      expect(block, `MemoryItem 上不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('置信度与挑记忆那一侧根本不 import 访问模块', () => {
    // 匹配的是 import 语句本身，不是字符串 `cognitive/access`：同目录的引用写作 './access'，
    // 只挡绝对路径写法会放走最近的那一种（P1 探针实测漏过一次）。
    for (const file of ['confidence.ts', 'evidence.ts', 'retrieval.ts', 'memory-module.ts']) {
      const source = readFileSync(resolve(process.cwd(), 'src', 'lib', 'cognitive', file), 'utf8');
      expect(source, `${file} 不该读访问记录`).not.toMatch(/from\s+['"][^'"]*\/access['"]/);
    }
  });
});

/**
 * 「并行任务不应该阻塞主回复」（任务书 8.1）在这一片是靠**位置**保证的：
 * 字节全部交给客户端之后才写这一行。所以这一条测的是源码里那两行的先后，不是快慢——
 * 写在 `controller.close()` 之前，一次数据库卡顿就成了用户眼里的「回答卡住了」。
 */
describe('写入点的位置（不阻塞主回复）', () => {
  const route = readFileSync(
    resolve(process.cwd(), 'src', 'app', 'api', 'chats', '[id]', 'messages', 'route.ts'),
    'utf8'
  );

  it('访问记录写在 done 帧和 close() 之后', () => {
    const done = route.indexOf("type: 'done'");
    expect(done, '找不到 done 帧').toBeGreaterThanOrEqual(0);
    const body = route.slice(done);
    // 成功分支现在调的是包了一层 try/catch 的 close()（客户端切走时 controller 可能已取消）。
    const closed = body.indexOf('close();');
    const written = body.indexOf('await recordMemoryAccess({');
    expect(closed, '成功分支里没有 close()').toBeGreaterThanOrEqual(0);
    expect(written, '成功分支里没有写访问记录').toBeGreaterThanOrEqual(0);
    expect(closed).toBeLessThan(written);
  });
});
