import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@/lib/crypto';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * 画像条目服务（任务书 8.2「用户画像」那一半的写侧）。
 *
 * 这一片唯一要钉住的事实是：**库里只存你确认过的**。这句话在这份实现里不是一句承诺，
 * 而是三个结构约束，每个都有用例对着：
 *
 * 一、`createProfileEntry` 的入参里**没有** `confirmedAt`。确认时间由服务在写入那一刻自己盖章，
 * 调用方递不进「未确认」这个状态——想写一行，就必须带着一次确认。
 * 二、`confirmedAt` 在 schema 里不可空，迁移 SQL 也不给它 DEFAULT，值只能来自服务。
 * 三、候选派生在纯函数层（profile-candidates.ts，另一份测试）。它产出的东西没有任何路径能直接进这张表
 * ——进表只经过 `createProfileEntry`，而那个函数只在「确认候选」或「你亲笔写」的请求里被调。
 *
 * 加密口径跟记忆表完全一致：正文是用户的话，AAD 绑 `userId + 行 id + 字段名`，
 * 别人的行即使密文到手也解不开；读别人的行先撞 403，连解都不解。
 *
 * 边界照旧如实说：跑的是 tests/unit/prisma-mock.ts 那个内存求值器，不是 SQL。
 * 「不可空」这条真库行为靠的是迁移文本断言 + 服务层永远盖章，替身拦不住一个绕过服务直接写行的调用方。
 */

const USER = 'user-a';
const OTHER = 'user-b';

function profileTable(): MockTable {
  return createTable({ defaults: () => ({ sourceMemoryIds: [], sourceReflectionIds: [], editedAt: null }) });
}

let table = profileTable();
// 事务里的表也用 getter：beforeEach 换掉 table 之后，服务在事务里写的必须是新那一份，
// 否则「删了一条，行还在」测的是夹具的旧引用而不是实现。
const tx = {
  get userProfileEntry() {
    return table;
  }
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    get userProfileEntry() {
      return table;
    },
    $transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)
  }
}));
vi.mock('@/lib/logger', () => ({
  log: { warn: () => undefined, error: () => undefined, info: () => undefined }
}));

/** 惰性 import：顶层 import 会让上面的工厂在 `table` 初始化之前就被调用。 */
async function service() {
  return await import('@/lib/cognitive/user-profile');
}

/** 源码在测试里现读：文件还不存在时红在「这个断言」上，不是整个文件在收集阶段炸掉。 */
function source(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

type WriteInput = {
  userId?: string;
  content?: string;
  sourceMemoryIds?: string[];
  sourceReflectionIds?: string[];
};

function input(overrides: WriteInput = {}) {
  return {
    userId: USER,
    content: '我在上海工作',
    sourceMemoryIds: ['mem-1'],
    sourceReflectionIds: [],
    ...overrides
  };
}

function rows(): Row[] {
  return [...table.rows.values()];
}

/** 画像模型那一段 schema 文本；模型还没建时返回空串，让断言以「缺这一行」的方式红。 */
function profileModel(): string {
  const schema = source('prisma/schema.prisma');
  return schema.match(/model UserProfileEntry \{([\s\S]*?)\n\}/)?.[1] ?? '';
}

beforeEach(() => {
  table = profileTable();
});

describe('画像条目：写进去就是确认过的', () => {
  it('新建的行一定带确认时间', async () => {
    const { createProfileEntry } = await service();
    const dto = await createProfileEntry(input());
    expect(dto.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rows()[0].confirmedAt).toBeInstanceOf(Date);
  });

  it('写入入参里根本没有「确认时间」这个旋钮', () => {
    // 「不确认也能写」只要留一个可选参数就成立，所以断的是入参形状，而不是断文档。
    // ProfileEntryInput 里多出一行 confirmedAt? 这条就红。
    const body = source('src/lib/cognitive/user-profile.ts').match(
      /export interface ProfileEntryInput \{([\s\S]*?)\n\}/
    )?.[1];
    expect(body).toBeDefined();
    expect(body).not.toContain('confirmedAt');
  });

  it('正文以密文落库，行里任何一列都不含明文', async () => {
    const { createProfileEntry } = await service();
    await createProfileEntry(input({ content: '我下个月要去京都出差' }));
    const row = rows()[0];
    expect(String(row.contentCiphertext).startsWith('enc:v1')).toBe(true);
    expect(JSON.stringify(row)).not.toContain('京都');
  });

  it('AAD 绑住这一行自己的 userId，别人的行连解都不解', async () => {
    const { createProfileEntry, decryptProfileEntryContent } = await service();
    const dto = await createProfileEntry(input());
    const row = rows()[0] as unknown as { id: string; userId: string; contentCiphertext: string };
    expect(decryptProfileEntryContent(row, USER)).toBe('我在上海工作');
    expect(() => decryptProfileEntryContent(row, OTHER)).toThrow('这条画像条目不属于当前用户');
    expect(dto.id).toBe(String(row.id));
  });

  it('空正文与超长正文都拒，超长要说得出上限', async () => {
    const { createProfileEntry, PROFILE_CONTENT_MAX_CHARS } = await service();
    await expect(createProfileEntry(input({ content: '   ' }))).rejects.toThrow('画像正文不能为空');
    await expect(
      createProfileEntry(input({ content: '字'.repeat(PROFILE_CONTENT_MAX_CHARS + 1) }))
    ).rejects.toThrow(String(PROFILE_CONTENT_MAX_CHARS));
    expect(rows()).toHaveLength(0);
  });

  it('来源 id 数组原样存，去重但不解释', async () => {
    const { createProfileEntry } = await service();
    await createProfileEntry(input({ sourceMemoryIds: ['mem-1', 'mem-2', 'mem-1'] }));
    expect(rows()[0].sourceMemoryIds).toEqual(['mem-1', 'mem-2']);
  });
});

describe('画像条目：改与删只认本人', () => {
  it('改正文重写同一行，editedAt 记上，读回是新内容', async () => {
    const { createProfileEntry, reviseProfileEntry } = await service();
    const dto = await createProfileEntry(input());
    const confirmedBefore = rows()[0].confirmedAt;
    const next = await reviseProfileEntry({ userId: USER, id: dto.id, content: '我搬到杭州了' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].id).toBe(dto.id);
    expect(next.content).toBe('我搬到杭州了');
    expect(next.editedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 第一次确认是来源事实，改动另有 editedAt 记着。改正文不许把确认时间偷偷刷新成「刚刚确认」，
    // 否则「你什么时候说过这个」会被后来的编辑覆盖掉。
    expect(rows()[0].confirmedAt).toBe(confirmedBefore);
  });

  it('改别人的条目改不到，密文原样留着', async () => {
    const { createProfileEntry, reviseProfileEntry } = await service();
    const dto = await createProfileEntry(input());
    const before = String(rows()[0].contentCiphertext);
    await expect(reviseProfileEntry({ userId: OTHER, id: dto.id, content: '改写' })).rejects.toMatchObject({
      status: 404
    });
    expect(String(rows()[0].contentCiphertext)).toBe(before);
  });

  it('删别人的删不到，返回 false 且行还在', async () => {
    const { createProfileEntry, deleteProfileEntry } = await service();
    const dto = await createProfileEntry(input());
    expect(await deleteProfileEntry(OTHER, dto.id)).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(await deleteProfileEntry(USER, dto.id)).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('清空只清当前用户的那批，返回清掉的条数', async () => {
    const { createProfileEntry, clearProfileEntries } = await service();
    await createProfileEntry(input());
    await createProfileEntry(input({ content: '我习惯早起' }));
    table.seed({ id: 'other-1', userId: OTHER, contentCiphertext: 'enc:v1:x', confirmedAt: new Date() });
    expect(await clearProfileEntries(USER)).toBe(2);
    expect(rows().map((row) => row.userId)).toEqual([OTHER]);
  });
});

describe('画像条目：读侧', () => {
  it('列表按确认时间倒序，且解得出正文', async () => {
    const { listProfileEntries } = await service();
    // 这里直接塞行而不是连着调两次新建：同一毫秒确认的两条并列时，倒序断言测到的是夹具的插入顺序，
    // 不是实现的 orderBy。倒序这件事要真的可分辨。
    const now = Date.now();
    ['早', '中', '晚'].forEach((label, index) => {
      table.seed({
        id: `p-${index}`,
        userId: USER,
        contentCiphertext: encryptString(label, `user-profile:v1:${USER}:p-${index}:content`),
        sourceMemoryIds: [],
        sourceReflectionIds: [],
        confirmedAt: new Date(now + index * 1000),
        editedAt: null,
        createdAt: new Date(now + index * 1000),
        updatedAt: new Date(now + index * 1000)
      });
    });
    const list = await listProfileEntries(USER);
    expect(list.map((entry) => entry.id)).toEqual(['p-2', 'p-1', 'p-0']);
    expect(list[0].content).toBe('晚');
  });

  it('列表最多带回 PROFILE_LIST_MAX_ROWS 条，静默少给要有个上限值可问', async () => {
    const { listProfileEntries, PROFILE_LIST_MAX_ROWS } = await service();
    const now = Date.now();
    for (let index = 0; index < PROFILE_LIST_MAX_ROWS + 3; index += 1) {
      table.seed({
        id: `row-${index}`,
        userId: USER,
        contentCiphertext: encryptString(`第${index}条`, `user-profile:v1:${USER}:row-${index}:content`),
        sourceMemoryIds: [],
        sourceReflectionIds: [],
        confirmedAt: new Date(now + index),
        editedAt: null,
        createdAt: new Date(now + index),
        updatedAt: new Date(now + index)
      });
    }
    const list = await listProfileEntries(USER);
    expect(PROFILE_LIST_MAX_ROWS).toBeGreaterThan(0);
    expect(list).toHaveLength(PROFILE_LIST_MAX_ROWS);
    // 「这一屏是被截断的」由路由算成 capped 字段（照 memories/route.ts:99 的口径），
    // 所以这里要钉的是：上限只有一个数，而且服务不会自己放宽它。capped 本身在路由测试里断。
    expect(list.length >= PROFILE_LIST_MAX_ROWS).toBe(true);
  });

  it('调用方能收紧上限，但放宽不了', async () => {
    const { listProfileEntries, PROFILE_LIST_MAX_ROWS } = await service();
    const now = Date.now();
    for (let index = 0; index < PROFILE_LIST_MAX_ROWS + 50; index += 1) {
      table.seed({
        id: `many-${index}`,
        userId: USER,
        contentCiphertext: encryptString(`第${index}条`, `user-profile:v1:${USER}:many-${index}:content`),
        sourceMemoryIds: [],
        sourceReflectionIds: [],
        confirmedAt: new Date(now + index),
        editedAt: null,
        createdAt: new Date(now + index),
        updatedAt: new Date(now + index)
      });
    }
    // 画像模块每轮对话都要读，只端 6 条；不带 limit 就是每轮解密两百多行。
    expect(await listProfileEntries(USER, 6)).toHaveLength(6);
    // 传一个比硬上限还大的数也不许越过那道闸——上限只有一个数，调用方只能往小收。
    expect(await listProfileEntries(USER, PROFILE_LIST_MAX_ROWS + 40)).toHaveLength(PROFILE_LIST_MAX_ROWS);
  });

  it('解不开的那行不拖垮整屏，正文位置换成一句实话', async () => {
    const { createProfileEntry, listProfileEntries } = await service();
    await createProfileEntry(input());
    table.seed({
      id: 'broken',
      userId: USER,
      contentCiphertext: 'enc:v1:not-a-real-ciphertext',
      sourceMemoryIds: [],
      sourceReflectionIds: [],
      confirmedAt: new Date(),
      editedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const list = await listProfileEntries(USER);
    expect(list).toHaveLength(2);
    expect(list.find((entry) => entry.id === 'broken')?.content).toBe('（画像条目解密失败）');
    expect(list.find((entry) => entry.id !== 'broken')?.content).toBe('我在上海工作');
  });

  it('别人的行一条也不读回来', async () => {
    const { createProfileEntry, listProfileEntries } = await service();
    await createProfileEntry(input());
    table.seed({ id: 'o', userId: OTHER, contentCiphertext: 'enc:v1:x', confirmedAt: new Date() });
    const list = await listProfileEntries(USER);
    expect(list.map((entry) => entry.id)).not.toContain('o');
  });
});

describe('画像条目的库层形状', () => {
  it('确认时间不可空：没有「先存着以后再说」这种行', () => {
    const model = profileModel();
    expect(model).toMatch(/confirmedAt\s+DateTime(\s+@|\s*\n)/);
    expect(model).not.toMatch(/confirmedAt\s+DateTime\?/);
  });

  it('正文只有密文列，没有能装下用户原话的明文列', () => {
    const model = profileModel();
    expect(model).toMatch(/contentCiphertext\s+String\s+@db\.Text/);
    // 能装文本的标量列只有三个：主键、归属、密文。再加一列（title / summary / label 之类）
    // 就是给用户的原话留一个明文抽屉，这条立刻红。String[] 的两个来源数组装的是 id，不算。
    const textColumns = [...model.matchAll(/^ {2}(\w+)\s+String(?!\[\])/gm)].map((found) => found[1]);
    expect(textColumns.sort()).toEqual(['contentCiphertext', 'id', 'userId']);
  });

  it('跟着账号消亡：用户对这一行是 Cascade', () => {
    expect(profileModel()).toMatch(/user\s+User\s+@relation\([^)]*onDelete:\s*Cascade\)/);
  });

  it('列表的读法有索引撑着（userId, confirmedAt）', () => {
    expect(profileModel()).toContain('@@index([userId, confirmedAt])');
  });

  it('迁移 SQL 真的建了这张表，且不给 confirmedAt 设默认值', () => {
    const sql = source('prisma/migrations/20261107000000_user_profile_entry/migration.sql');
    expect(sql).toMatch(/CREATE TABLE "UserProfileEntry"/);
    expect(sql).toMatch(/"confirmedAt" TIMESTAMP\(3\)(?! DEFAULT)/);
  });

  it('「清空全部长期记忆」不碰这张表——它是你确认过的东西，不是派生记录', () => {
    expect(source('src/lib/cognitive/forgetting.ts')).not.toMatch(/userProfileEntry/);
  });
});
