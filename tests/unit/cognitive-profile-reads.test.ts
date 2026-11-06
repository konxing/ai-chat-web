import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@/lib/crypto';
import { PROFILE_CANDIDATE_MEMORY_NOTE, PROFILE_CANDIDATE_REFLECTION_NOTE } from '@/lib/cognitive/user-profile-display';
import { createTable, type MockTable, type Row } from './prisma-mock';

/**
 * 画像一屏的读侧组装（任务书 8.2 / 8.3）。
 *
 * 候选的三条规则本身是纯函数层的事（profile-candidates.ts，另一份测试钉过）。这一份钉的是**接线**：
 * 纯函数拿到的那批行，是不是真的、按开关、不越界地从库里来的。六个洞各对着一条用例：
 *
 * 一、开关关着必须是**一次查询都不发**，不是「查了再过滤」。这一屏读的是密文（记忆正文、洞察标题、
 *     画像正文），闸门晚一步就等于给关了模块的用户整屏解密（任务书 1.1）。
 * 二、画像条目**不受**那两个来源开关影响：它是你确认过的东西，不是派生记录。关掉长期记忆之后
 *     这一屏仍然看得见、改得掉、删得掉自己确认过的画像，只是不再端出新的候选。
 * 三、洞察候选要读的是**被引用那几行的情境列**，所以它也得过长期记忆这道闸——
 *     候选的两路都要读 MemoryItem，一路读正文、一路读情境。
 * 四、情境闸门认的是**被引用的那条记忆自己的情境**，归档行也算：一条洞察引用过的记忆后来被收进
 *     归档，它的情境照样能把关着的情境挡住。
 * 五、解不开密文就**说不出**，不编（门槛 4）：标题解不开的那条洞察不成候选，其余照常。
 * 六、洞察的标题密文住在 `ReflectionRecord`，而这一片不许 import 洞察那两条路由的模块
 *     （`cognitive-reflection-states.test.ts` 钉着），所以 AAD 式子是抄过来的——
 *     最后一条用例把两边的式子钉成同一个，改了任何一边都会红。
 */

const USER = 'user-a';

interface Call {
  table: string;
  op: string;
}

function counted(name: string, table: MockTable, sink: Call[]): MockTable {
  return {
    ...table,
    findMany: (args) => {
      sink.push({ table: name, op: 'findMany' });
      return table.findMany(args);
    },
    findUnique: (args) => {
      sink.push({ table: name, op: 'findUnique' });
      return table.findUnique(args);
    },
    create: (args) => {
      sink.push({ table: name, op: 'create' });
      return table.create(args);
    },
    updateMany: (args) => {
      sink.push({ table: name, op: 'updateMany' });
      return table.updateMany(args);
    },
    deleteMany: (args) => {
      sink.push({ table: name, op: 'deleteMany' });
      return table.deleteMany(args);
    }
  };
}

let calls: Call[] = [];
let preferenceRow: Row | null = null;
let preferenceThrows = false;

/** 偏好表只被读：`findUnique` 的返回值由下面两个变量当场决定，读不出来的时候按全关。 */
const preferenceTable: MockTable = {
  ...createTable(),
  findUnique: () => (preferenceThrows ? Promise.reject(new Error('数据库连接中断')) : Promise.resolve(preferenceRow))
};

const tables = {
  get cognitivePreference() {
    return counted('cognitivePreference', preferenceTable, calls);
  },
  get memoryItem() {
    return counted('memoryItem', memoryTable, calls);
  },
  get memoryPolicy() {
    return counted('memoryPolicy', policyTable, calls);
  },
  get userProfileEntry() {
    return counted('userProfileEntry', profileTable, calls);
  },
  get reflectionRecord() {
    return counted('reflectionRecord', reflectionTable, calls);
  },
  get reflectionCitation() {
    return counted('reflectionCitation', citationTable, calls);
  }
};

vi.mock('@/lib/prisma', () => ({
  prisma: tables
}));
vi.mock('@/lib/logger', () => ({
  log: { warn: () => undefined, error: () => undefined, info: () => undefined }
}));

let memoryTable = createTable();
let policyTable = createTable();
let profileTable = createTable({ defaults: () => ({ sourceMemoryIds: [], sourceReflectionIds: [], editedAt: null }) });
let reflectionTable = createTable();
let citationTable = createTable();

/** 惰性 import：顶层 import 会让替身 getter 在表初始化之前就被调用。 */
async function screen() {
  return await import('@/lib/cognitive/profile-reads');
}

function source(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

const NOW = new Date('2026-11-05T10:00:00.000Z');

function memoryRow(overrides: Row = {}): Row {
  const id = String(overrides.id ?? 'mem-1');
  return {
    id,
    userId: USER,
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'FACT',
    context: 'GENERAL',
    origin: 'EXPLICIT',
    contentCiphertext: encryptString('我在上海工作', `memory:v1:${USER}:${id}`),
    confirmedAt: null,
    validPrecision: 'UNKNOWN',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    archivedAt: null,
    recordedAt: new Date('2026-11-01T10:00:00.000Z'),
    ...overrides
  };
}

function reflectionRow(overrides: Row = {}): Row {
  const id = String(overrides.id ?? 'ref-1');
  const title = overrides.titlePlain === undefined ? '你最近总在深夜谈工作' : String(overrides.titlePlain);
  const row: Row = {
    id,
    userId: USER,
    type: 'PATTERN',
    status: 'ACCEPTED',
    titleCiphertext: encryptString(title, `reflection:v1:${USER}:${id}:title`),
    generatedAt: new Date('2026-11-02T10:00:00.000Z'),
    ...overrides
  };
  delete row.titlePlain;
  return row;
}

function profileRow(overrides: Row = {}): Row {
  const id = String(overrides.id ?? 'pro-1');
  return {
    id,
    userId: USER,
    contentCiphertext: encryptString('我习惯先把事写完再聊', `user-profile:v1:${USER}:${id}:content`),
    sourceMemoryIds: [],
    sourceReflectionIds: [],
    confirmedAt: new Date('2026-11-03T10:00:00.000Z'),
    editedAt: null,
    ...overrides
  };
}

const OPEN = { userModelEnabled: true, memoryEnabled: true, reflectionEnabled: true };

beforeEach(() => {
  calls = [];
  preferenceRow = null;
  preferenceThrows = false;
  memoryTable = createTable();
  policyTable = createTable();
  profileTable = createTable({ defaults: () => ({ sourceMemoryIds: [], sourceReflectionIds: [], editedAt: null }) });
  reflectionTable = createTable();
  citationTable = createTable();
});

describe('闸门：关着是真的不读', () => {
  it('长期记忆关着：候选为空，MemoryItem 和 ReflectionRecord 一次都不查', async () => {
    memoryTable.seed(memoryRow());
    reflectionTable.seed(reflectionRow());
    citationTable.seed({ id: 'cit-1', userId: USER, reflectionId: 'ref-1', memoryId: 'mem-1' });

    const result = await (await screen()).readProfileScreen(USER, NOW, { ...OPEN, memoryEnabled: false });

    expect(result.candidates).toEqual([]);
    expect(calls.filter((call) => call.table === 'memoryItem')).toEqual([]);
    expect(calls.filter((call) => call.table === 'reflectionRecord')).toEqual([]);
    expect(calls.filter((call) => call.table === 'reflectionCitation')).toEqual([]);
  });

  it('长期记忆关着，已确认的画像条目照常带回：它不是派生记录', async () => {
    profileTable.seed(profileRow({ id: 'pro-1' }));

    const result = await (await screen()).readProfileScreen(USER, NOW, { ...OPEN, memoryEnabled: false });

    expect(result.entries.map((entry: { id: string }) => entry.id)).toEqual(['pro-1']);
    expect(result.entries[0].content).toBe('我习惯先把事写完再聊');
  });

  it('洞察关着：只有记忆那一路的候选，洞察表一次都不查', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1' }));
    reflectionTable.seed(reflectionRow({ id: 'ref-1' }));

    const result = await (await screen()).readProfileScreen(USER, NOW, { ...OPEN, reflectionEnabled: false });

    expect(result.candidates.map((candidate: { from: string }) => candidate.from)).toEqual(['memory']);
    expect(calls.filter((call) => call.table === 'reflectionRecord')).toEqual([]);
  });

  it('两路都开着才去读策略表：谁都不要时不查', async () => {
    await (await screen()).readProfileScreen(USER, NOW, { ...OPEN, memoryEnabled: false });

    expect(calls.filter((call) => call.table === 'memoryPolicy')).toEqual([]);
  });

  it('偏好读不出来时三个闸门全按关闭处理', async () => {
    preferenceThrows = true;

    const gates = await (await screen()).profileGates(USER);

    expect(gates).toEqual({ userModelEnabled: false, memoryEnabled: false, reflectionEnabled: false });
  });

  it('偏好行缺列时按默认值读：三个开关各看自己那一列', async () => {
    preferenceRow = { userId: USER, userModelEnabled: true, memoryEnabled: true, reflectionEnabled: false };

    const gates = await (await screen()).profileGates(USER);

    expect(gates).toEqual({ userModelEnabled: true, memoryEnabled: true, reflectionEnabled: false });
  });
});

describe('候选：来自哪一路、由谁把关', () => {
  it('当前有效的记忆成为候选，正文是真的解了密的那句', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1' }));

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      from: 'memory',
      content: '我在上海工作',
      note: PROFILE_CANDIDATE_MEMORY_NOTE,
      sourceMemoryIds: ['mem-1']
    });
  });

  it('系统观察到的记忆不成候选：候选只从你说过或确认过的来', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1', origin: 'OBSERVED' }));

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates).toEqual([]);
  });

  it('已经收进画像的那条记忆不再回头问第二遍', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1' }), memoryRow({ id: 'mem-2', contentCiphertext: encryptString('我周日要留给家里', `memory:v1:${USER}:mem-2`) }));
    profileTable.seed(profileRow({ id: 'pro-1', sourceMemoryIds: ['mem-1'] }));

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates.map((candidate: { sourceMemoryIds: string[] }) => candidate.sourceMemoryIds)).toEqual([
      ['mem-2']
    ]);
  });

  it('采纳过的洞察成为候选：标题解得开，标注逐字是那句「系统推断，未经你确认」', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1' }));
    reflectionTable.seed(reflectionRow({ id: 'ref-1' }));
    citationTable.seed({ id: 'cit-1', userId: USER, reflectionId: 'ref-1', memoryId: 'mem-1' });

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    const fromReflection = result.candidates.filter((candidate: { from: string }) => candidate.from === 'reflection');
    expect(fromReflection).toHaveLength(1);
    expect(fromReflection[0]).toMatchObject({
      content: '你最近总在深夜谈工作',
      note: PROFILE_CANDIDATE_REFLECTION_NOTE,
      sourceReflectionIds: ['ref-1']
    });
  });

  it('PENDING 和 REJECTED 的洞察不成候选：状态过滤在库里，不是在界面里', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1' }));
    reflectionTable.seed(
      reflectionRow({ id: 'ref-pending', status: 'PENDING' }),
      reflectionRow({ id: 'ref-rejected', status: 'REJECTED' }),
      reflectionRow({ id: 'ref-edited', status: 'EDITED' })
    );
    citationTable.seed({ id: 'cit-1', userId: USER, reflectionId: 'ref-edited', memoryId: 'mem-1' });

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates.filter((candidate: { from: string }) => candidate.from === 'reflection').map((candidate: { sourceReflectionIds: string[] }) => candidate.sourceReflectionIds)).toEqual([
      ['ref-edited']
    ]);
  });

  it('标题解不开就不摆那一条：宁可少列，不编一句', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-1' }));
    reflectionTable.seed(
      reflectionRow({ id: 'ref-bad', titleCiphertext: 'enc:v1:这不是那条 AAD 下写出来的密文' }),
      reflectionRow({ id: 'ref-good' })
    );
    citationTable.seed(
      { id: 'cit-1', userId: USER, reflectionId: 'ref-bad', memoryId: 'mem-1' },
      { id: 'cit-2', userId: USER, reflectionId: 'ref-good', memoryId: 'mem-1' }
    );

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates.filter((candidate: { from: string }) => candidate.from === 'reflection').map((candidate: { sourceReflectionIds: string[] }) => candidate.sourceReflectionIds)).toEqual([
      ['ref-good']
    ]);
  });

  it('引用过的记忆被归档了，它的情境照样把关：关着的门不许从旁边绕过去', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-quiet', context: 'EMOTIONAL_SUPPORT', archivedAt: new Date('2026-11-04T10:00:00.000Z') }));
    reflectionTable.seed(reflectionRow({ id: 'ref-1' }));
    citationTable.seed({ id: 'cit-1', userId: USER, reflectionId: 'ref-1', memoryId: 'mem-quiet' });

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    // emotionalSupport 的内置默认是 allowUserProfile: false，而这条洞察只引用了它。
    expect(result.candidates.filter((candidate: { from: string }) => candidate.from === 'reflection')).toEqual([]);
  });

  it('别人的记忆、别人的洞察、别人的画像：一行都不进来', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-x', userId: 'user-b' }));
    reflectionTable.seed(reflectionRow({ id: 'ref-x', userId: 'user-b' }));
    citationTable.seed({ id: 'cit-x', userId: 'user-b', reflectionId: 'ref-x', memoryId: 'mem-x' });
    profileTable.seed(profileRow({ id: 'pro-x', userId: 'user-b' }));

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.entries).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it('引用行读到了上限：整条洞察那一路都不提议，不是拿一批残缺的引用去过关闸门', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-quiet', context: 'EMOTIONAL_SUPPORT' }));
    memoryTable.seed(memoryRow({ id: 'mem-open', context: 'GENERAL' }));
    reflectionTable.seed(reflectionRow({ id: 'ref-1' }));
    // 200 条开放情境的引用 + 1 条关闭情境的引用，倒序截断掉的就是最后那一条：
    // 少了这道闸，这条洞察看起来只引用了 general，于是从旁边绕过了 emotionalSupport 的门。
    for (let index = 0; index < 200; index += 1) {
      citationTable.seed({ id: `cit-${index}`, userId: USER, reflectionId: 'ref-1', memoryId: 'mem-open' });
    }
    citationTable.seed({ id: 'cit-last', userId: USER, reflectionId: 'ref-1', memoryId: 'mem-quiet' });

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates.filter((candidate: { from: string }) => candidate.from === 'reflection')).toEqual([]);
    // 记忆那一路不受影响：它读的是自己的列表，和引用表没关系。
    expect(result.candidates.map((candidate: { from: string }) => candidate.from)).toContain('memory');
  });

  it('引用指向一条已经不存在的记忆：这条洞察不提议，而不是把认不出的来源当成「没有引用」', async () => {
    memoryTable.seed(memoryRow({ id: 'mem-open', context: 'GENERAL' }));
    reflectionTable.seed(reflectionRow({ id: 'ref-1' }));
    citationTable.seed(
      { id: 'cit-1', userId: USER, reflectionId: 'ref-1', memoryId: 'mem-open' },
      { id: 'cit-2', userId: USER, reflectionId: 'ref-1', memoryId: 'mem-gone' }
    );

    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.candidates.filter((candidate: { from: string }) => candidate.from === 'reflection')).toEqual([]);
  });

  it('什么都不存在时返回两份空列表，不报错', async () => {
    const result = await (await screen()).readProfileScreen(USER, NOW, OPEN);

    expect(result.entries).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.entriesCapped).toBe(false);
  });
});

describe('截断要说出来', () => {
  it('条目读满 200 行时 entriesCapped 为真', async () => {
    const { PROFILE_LIST_MAX_ROWS } = await import('@/lib/cognitive/user-profile');
    for (let index = 0; index < PROFILE_LIST_MAX_ROWS; index += 1) {
      profileTable.seed(profileRow({ id: `pro-${index}` }));
    }

    const result = await (await screen()).readProfileScreen(USER, NOW, { ...OPEN, memoryEnabled: false });

    expect(result.entries).toHaveLength(PROFILE_LIST_MAX_ROWS);
    expect(result.entriesCapped).toBe(true);
  });
});

describe('抄过来的那道锁', () => {
  it('这一片不 import 洞察那两条路由的模块（静态禁令），两边都按模型 + 列查同一张表', async () => {
    const body = source('src/lib/cognitive/profile-reads.ts');
    const reflections = source('src/lib/cognitive/reflections.ts');
    expect(body).not.toContain('@/lib/cognitive/reflections');
    // AAD 的式子不再各抄一份：两边都必须按「ReflectionRecord + titleCiphertext」去覆盖表里查。
    // 表本身和 schema 的逐列对照由 `cognitive-rotate-coverage.test.ts` 的 A 组钉住。
    expect(reflections).toContain("cognitiveColumnAad('ReflectionRecord'");
    expect(body).toContain("cognitiveColumnAad('ReflectionRecord'");
    expect(body).toContain("'titleCiphertext'");
  });
});
