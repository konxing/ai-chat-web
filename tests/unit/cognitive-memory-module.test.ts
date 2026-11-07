import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ③ 接线：把策略真正跑在对话链路上。这一片钉的是四件事——
 * 关着就一行都不落；落库的是「用户亲口说」而不是系统猜的；模糊时间不许编造；
 * 以及读出来的记忆只能作为「数据」进提示词，不能变成指令。
 *
 * memories / preferences / policy 三个依赖在这里是 mock 的：
 * 它们各自的行为在 cognitive-memories、cognitive-memory-policy、cognitive-preferences 里已经测过，
 * 这里要测的是把它们串起来的那段决策与渲染。
 */
const db = vi.hoisted(() => ({
  memoryEnabled: false,
  memoryWritePaused: false,
  emotionEnabled: false,
  creates: [] as Array<Record<string, unknown>>,
  revises: [] as Array<Record<string, unknown>>,
  proposals: [] as Array<Record<string, unknown>>,
  readRows: [] as Array<Record<string, unknown>>,
  listFilters: [] as unknown[],
  excluded: [] as string[],
  exclusionCalls: [] as string[],
  evidenceCalls: [] as Array<Record<string, unknown>>,
  evidenceThrows: false,
  assessCalls: [] as string[],
  assessReturnsEmpty: false,
  band: 'medium' as 'low' | 'medium' | 'high',
  policies: null as unknown,
  emotionTransparency: 'implicit' as 'off' | 'implicit' | 'explicit',
  memoryReadLimit: 8,
  timezoneOffsetMinutes: null as number | null,
  associationEnabled: false,
  expandCalls: [] as unknown[],
  expandHits: [] as Array<Record<string, unknown>>,
  policyCalls: 0
}));

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: () =>
    Promise.resolve({
      memoryEnabled: db.memoryEnabled,
      userModelEnabled: false,
      emotionEnabled: db.emotionEnabled,
      associationEnabled: db.associationEnabled,
      timelineEnabled: false,
      reflectionEnabled: false,
      decisionMemoryEnabled: false,
      adaptiveMemoryEnabled: false,
      emotionTransparency: db.emotionTransparency,
      memoryWritePaused: db.memoryWritePaused,
      memoryReadLimit: db.memoryReadLimit,
      timezoneOffsetMinutes: db.timezoneOffsetMinutes
    })
}));

vi.mock('@/lib/cognitive/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/policy')>();
  return {
    ...actual,
    // 库里一行都没配过 → 用内置默认，测试直接断言默认策略下的行为。
    // db.policies 有值时用它：保留期那几条要能单独把某个情境改成 days30。
    getMemoryPolicies: () => {
      db.policyCalls += 1;
      return Promise.resolve(db.policies ?? actual.DEFAULT_MEMORY_POLICIES);
    }
  };
});

vi.mock('@/lib/cognitive/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/memories')>();
  return {
    ...actual,
    // 只替换落库和捞取的出入口；标签、时间回显这些纯函数走真实实现。
    createMemory: (input: Record<string, unknown>) => {
      db.creates.push(input);
      return Promise.resolve({ id: 'mem-new' });
    },
    reviseMemory: (input: Record<string, unknown>) => {
      db.revises.push(input);
      return Promise.resolve({ id: 'mem-new' });
    },
    listMemories: (userId: string, filters?: { take?: number }) => {
      db.listFilters.push({ userId, filters });
      // 真实 listMemories 按 recordedAt 倒序再 take，这里按同一套语义截断，
      // 否则「只注入 8 条」是靠调用方 slice 还是靠查询上限就分不出来了。
      const rows = db.readRows
        .filter((row) => row.userId === userId)
        .slice(0, filters?.take)
        .map((row) => ({ ...row, userId }));
      return Promise.resolve(rows);
    }
  };
});

vi.mock('@/lib/cognitive/relations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/relations')>();
  return {
    ...actual,
    // 扩展本身在 cognitive-relations 里逐条测过；这里只测串起来的那一段：
    // associationEnabled 开着才问关系表，问回来的行确实进了同一个注入块。
    expandRelatedMemories: (input: unknown) => {
      db.expandCalls.push(input);
      return Promise.resolve(db.expandHits as never);
    }
  };
});

vi.mock('@/lib/cognitive/memory-candidates', () => ({
  // 「先问再记」的出口换成探针：候选表本身在 cognitive-memory-candidates 里测过了，
  // 这里要测的是写侧有没有在 ASK_CONFIRM 那一支真的去问，而不是继续把这句话丢掉。
  proposeCandidate: (input: Record<string, unknown>) => {
    db.proposals.push(input);
    return Promise.resolve({ id: 'cand-1', created: true });
  }
}));

vi.mock('@/lib/cognitive/exclusions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/exclusions')>();
  return {
    ...actual,
    // 哈希用真实现：归一化和 HMAC 绑定本身在 cognitive-exclusions 里测过了，
    // 这里要测的是写侧有没有拿它当闸门。
    excludedHashes: (userId: string) => {
      db.exclusionCalls.push(userId);
      return Promise.resolve(new Set(db.excluded));
    }
  };
});

vi.mock('@/lib/cognitive/evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/evidence')>();
  return {
    ...actual,
    // 打分和记账都在这里换成探针：算分规则本身在 cognitive-confidence / cognitive-evidence 里测过，
    // 这里要测的是模块有没有在正确的时机调用它们、以及低档位有没有被标出来。
    assessMemories: (userId: string, memories: Array<{ id: string }>) => {
      db.assessCalls.push(userId);
      if (db.assessReturnsEmpty) return Promise.resolve(new Map());
      return Promise.resolve(
        new Map(memories.map((memory) => [memory.id, { score: 0.6, band: db.band, factors: [] }]))
      );
    },
    recordEvidenceOutsideTransaction: (input: Record<string, unknown>) => {
      db.evidenceCalls.push(input);
      return db.evidenceThrows ? Promise.reject(new Error('证据写入失败')) : Promise.resolve();
    }
  };
});

import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import { exclusionHash } from '@/lib/cognitive/exclusions';
import {
  ensureCognitiveModules,
  memoryModule,
  MEMORY_READ_MAX_CHARS,
  MEMORY_RETRIEVAL_POOL,
  MEMORY_READ_MAX_ITEMS,
  MEMORY_WRITE_MAX_PER_TURN,
  renderMemoryBlock
} from '@/lib/cognitive/memory-module';
import { runCognitiveReads } from '@/lib/cognitive/manager';
import type { MemoryDto } from '@/lib/cognitive/memories';

const TURN = { userId: 'user-a', chatId: 'chat-1', content: '', sourceMessageId: 'msg-1' };
const OCCURRED = new Date('2026-11-02T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** 保留期是按「服务器现在」算的，所以这些用例的时间戳必须相对真实当下，不能用固定的 OCCURRED。 */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function withRetention(retention: 'days30' | 'sessionOnly') {
  return {
    ...DEFAULT_MEMORY_POLICIES,
    technicalProject: { ...DEFAULT_MEMORY_POLICIES.technicalProject, retention }
  };
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    userId: 'user-a',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'project',
    context: 'technicalProject',
    origin: 'explicit',
    content: '我在用 Prisma',
    confirmedAt: OCCURRED.toISOString(),
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: OCCURRED.toISOString(),
    ...overrides
  };
}

async function write(content: string) {
  await memoryModule.write!({ ...TURN, content, occurredAt: OCCURRED });
}

beforeEach(() => {
  db.memoryEnabled = false;
  db.memoryWritePaused = false;
  db.emotionEnabled = false;
  db.creates = [];
  db.revises = [];
  db.proposals = [];
  db.readRows = [];
  db.listFilters = [];
  db.excluded = [];
  db.exclusionCalls = [];
  db.evidenceCalls = [];
  db.evidenceThrows = false;
  db.assessCalls = [];
  db.assessReturnsEmpty = false;
  db.band = 'medium';
  db.policies = null;
  db.emotionTransparency = 'implicit';
  db.policyCalls = 0;
  db.memoryReadLimit = 8;
  db.timezoneOffsetMinutes = null;
  db.associationEnabled = false;
  db.expandCalls = [];
  db.expandHits = [];
});

describe('写侧：策略在服务端真的生效', () => {
  it('长期记忆开关关着时，一行都不会落库', async () => {
    db.memoryEnabled = false;

    await write('我在用 Next.js 15 和 Prisma。');

    expect(db.creates).toEqual([]);
  });

  it('开关打开后，技术项目的亲口陈述按「用户明说」落库，且不编造时间', async () => {
    db.memoryEnabled = true;

    await write('我在用 Next.js 15 和 Prisma。');

    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({
      userId: 'user-a',
      chatId: 'chat-1',
      sourceMessageId: 'msg-1',
      type: 'project',
      context: 'technicalProject',
      origin: 'explicit',
      precision: 'unknown',
      content: '我在用 Next.js 15 和 Prisma'
    });
    expect(db.creates[0].confirmedAt).toEqual(OCCURRED);
    expect(db.creates[0].validFrom).toBeNull();
  });

  /**
   * 4-T2 接线：写侧的时间来源只有这一个入口。
   * 两句放在一起才看得出这不是「总落 validFrom」也不是「永远不落」——
   * 词表里认得出的那个说法落，认不出的一律维持 unknown。
   */
  it('句子里有词表内的时间说法时，精度和 validFrom 一起落下', async () => {
    db.memoryEnabled = true;

    // OCCURRED 是 2026-11-02，所以「去年」是 2025 年，且必须对齐到 1 月 1 日 00:00。
    await write('去年我住在杭州。');

    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({
      content: '去年我住在杭州',
      precision: 'year',
      validFrom: new Date('2025-01-01T00:00:00.000Z')
    });
  });

  it('周档和循环说法不在词表里：这句照样按时间未知落库', async () => {
    db.memoryEnabled = true;

    await write('我习惯周三打球。');

    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({ precision: 'unknown', validFrom: null });
  });

  it('决策情境默认要先问再记：不落库，但这句话必须变成一条待确认候选', async () => {
    db.memoryEnabled = true;

    await write('我决定下周三辞职。');

    expect(db.creates).toEqual([]);
    expect(db.proposals).toHaveLength(1);
    expect(db.proposals[0]).toMatchObject({
      userId: 'user-a',
      chatId: 'chat-1',
      sourceMessageId: 'msg-1',
      type: 'decision',
      context: 'decisionMaking',
      content: '我决定下周三辞职'
    });
  });

  it('敏感情境和普通情境分数打平时取最保守的一条，敏感情境不落库', async () => {
    db.memoryEnabled = true;

    await write('我在用 Prisma 时焦虑。');

    expect(db.creates).toEqual([]);
    // 最保守那条是「这个情境根本不留」，不是「问一句」——歧义不许被翻译成一次打扰。
    expect(db.proposals).toEqual([]);
  });

  it('同一句话第二次说不产生重复行', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];

    await write('我在用 Prisma。');

    expect(db.creates).toEqual([]);
  });

  /**
   * 归档的行仍由服务层默认口径排除，写侧不自己放宽；但被取代的旧版本必须留在匹配池里——
   * 用户改口（我住北京 → 我住上海）后再原话重说「我住北京」，known 表靠旧行拦得住，
   * 缺了它同一句话会落成第二条当前版本，两条互相冲突。
   */
  it('写侧的匹配池带被取代的旧版本，但不捞归档行', async () => {
    db.memoryEnabled = true;

    await write('我在用 Prisma。');

    const call = db.listFilters[db.listFilters.length - 1] as { userId: string; filters?: unknown };
    expect(call.userId).toBe('user-a');
    expect(call.filters).toEqual({ includeSuperseded: true });
  });

  it('被取代的旧版本仍拦住原话重说：不会落成第二条当前版本', async () => {
    db.memoryEnabled = true;
    // 模拟 includeSuperseded 的真实返回：这行已被「我住上海」取代，但正文还在池子里。
    db.readRows = [memoryRow({ id: 'mem-old', content: '我住北京', chatId: 'chat-9' })];

    await write('我住北京。');

    expect(db.creates).toEqual([]);
  });

  it('一轮里最多落两条，防止一条长消息灌库', async () => {
    db.memoryEnabled = true;

    await write('我在用 Prisma。我住在杭州。我喜欢喝温水。我打算考研。');

    expect(db.creates).toHaveLength(MEMORY_WRITE_MAX_PER_TURN);
  });
});

/**
 * 片M 接线：策略里那个「先问再记」以前是空转的——`planMemoryWrite` 判出 ASK_CONFIRM 之后，
 * 写侧只有一句 `continue`，这句话既没记住也没问过，直接消失。现在它进候选表等用户回答。
 *
 * 这里逐条钉的是**闸门也得盖住候选**：总开关关着、写入暂停着、内容被永久删除过——
 * 这三种情况下「问一句」和「落一行」同样是不该发生的写。候选不写记忆行，所以它不占那一轮两条的
 * 落库额度，但它同样消耗用户的注意力，因此另有自己的一轮两条上限：那句只是存着等用户哪天答，
 * 不当场打断他，所以落库和提问两笔账各算各的。
 */
describe('写侧：先问再记真的去问（ASK_CONFIRM → 待确认候选）', () => {
  it('候选带上这句话自己的时间口径，不把它压成时间未知', async () => {
    db.memoryEnabled = true;

    await write('去年我决定辞职。');

    expect(db.proposals).toHaveLength(1);
    expect(db.proposals[0]).toMatchObject({
      content: '去年我决定辞职',
      precision: 'year',
      validFrom: new Date('2025-01-01T00:00:00.000Z')
    });
  });

  it('长期记忆总开关关着时，连一句「要不要记」都不问', async () => {
    db.memoryEnabled = false;

    await write('我纠结了很久，我决定下周三辞职。');

    expect(db.proposals).toEqual([]);
  });

  it('暂停长期记忆写入时也不问：暂停的是这条链路的全部动作', async () => {
    db.memoryEnabled = true;
    db.memoryWritePaused = true;

    await write('我纠结了很久，我决定下周三辞职。');

    expect(db.proposals).toEqual([]);
    expect(db.exclusionCalls).toEqual([]);
  });

  it('用户永久删除过的这句话不再问第二遍', async () => {
    db.memoryEnabled = true;
    db.excluded = [exclusionHash('user-a', '我决定下周三辞职')];

    await write('我决定下周三辞职。');

    expect(db.proposals).toEqual([]);
  });

  it('库里已经有同一句话时按重复陈述处理，不再问一遍', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ type: 'decision', content: '我决定下周三辞职' })];

    await write('我决定下周三辞职。');

    expect(db.proposals).toEqual([]);
    expect(db.creates).toEqual([]);
  });

  it('一轮最多问两条，第三条这次就不占了', async () => {
    db.memoryEnabled = true;

    await write('我决定辞职。我定了要不要换房。我选了预算更低的那家。');

    expect(db.proposals).toHaveLength(MEMORY_WRITE_MAX_PER_TURN);
    expect(db.creates).toEqual([]);
  });

  /**
   * 两条额度各算各的，这里钉的是「各算各的」这件事本身：
   * 有人把计数器合并成一个（看着更严格），落库就会把问句的位置吃掉——用户设了「先问再记」，
   * 可这一轮一旦写掉两行，后面那些该问的句子就一句都不问了，策略又回到空转，正是片M 修的那个毛病。
   */
  it('落库和问句各算各的额度：落了一行不挤掉问句的位置', async () => {
    db.memoryEnabled = true;

    await write('我在用 Next.js 15 和 Prisma。我决定辞职。我定了要不要换房。');

    expect(db.creates).toHaveLength(1);
    expect(db.proposals).toHaveLength(MEMORY_WRITE_MAX_PER_TURN);
  });

  /**
   * 问过两条之后的 break 会把排在后面的 WRITE 候选一起丢掉：用户先说两句决策话、
   * 再说一句普通事实，那句事实曾经静默消失。挤掉的只能是超额的问句本身。
   */
  it('问过两条之后，排在后面的可写候选照常落库', async () => {
    db.memoryEnabled = true;

    await write('我决定辞职。我定了要不要换房。我在用 Prisma。');

    expect(db.proposals).toHaveLength(MEMORY_WRITE_MAX_PER_TURN);
    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({ content: '我在用 Prisma' });
  });

  it('用户没设「先问」的情境照常落库，候选表一个都不写', async () => {
    db.memoryEnabled = true;

    await write('我在用 Next.js 15 和 Prisma。');

    expect(db.creates).toHaveLength(1);
    expect(db.proposals).toEqual([]);
  });

  it('相对时间按偏好里的用户时区锚墙钟：UTC+8 本地清晨的「昨天」不多退一天', async () => {
    db.memoryEnabled = true;
    db.timezoneOffsetMinutes = 480;

    // 说话时刻 = UTC 2026-11-06 16:30 = 本地 11-07 00:30；「昨天」是本地 11-06。
    await memoryModule.write!({
      ...TURN,
      content: '我在做昨天的复盘。',
      occurredAt: new Date('2026-11-06T16:30:00.000Z')
    });

    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({ precision: 'day', validFrom: new Date('2026-11-06T00:00:00.000Z') });
  });
});

/**
 * ④ 演化接线：用户把同一件事又说了一遍、只是某个值换了。
 * 这里钉的是「不许并排放进两条当前版本」——读侧只能按 recordedAt 倒序挑，
 * 两条都有效就等于 AI 自己猜用户现在到底用哪个版本。
 *
 * 反面同样要钉住：句子只是像，不代表同一件事。误取代的代价是销毁一条用户真说过的话，
 * 比多留一条脏数据贵得多，所以相似度不够时一律并存。
 */
describe('写侧：同一件事的新说法走演化，不新增第二条', () => {
  it('库里已有同一件事的旧说法时，改口写成新版本而不是再落一条', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ content: '我在用 Next.js 14' })];

    await write('我在用 Next.js 15。');

    expect(db.creates).toEqual([]);
    expect(db.revises).toHaveLength(1);
    expect(db.revises[0]).toMatchObject({
      userId: 'user-a',
      previousId: 'mem-1',
      content: '我在用 Next.js 15',
      // 改口的仍然是用户原话，来源不能因为「系统认出来了」就升级成已确认。
      origin: 'explicit',
      precision: 'unknown',
      type: 'project'
    });
    // 情境沿用旧行：这句短话的分类比旧行更弱，顺手换主题等于把用户当初说清的信息弄丢。
    expect(db.revises[0].context).toBeUndefined();
    expect(db.revises[0].confirmedAt).toEqual(OCCURRED);
  });

  it('说法只是长得像、说的不是同一件事时并存，绝不自动取代', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ content: '我在用 React 写页面' })];

    await write('我在用 Vue 写页面。');

    expect(db.revises).toEqual([]);
    expect(db.creates).toHaveLength(1);
    expect(db.creates[0].content).toBe('我在用 Vue 写页面');
  });

  it('关掉长期记忆时既不新增也不演化，连旧行都不碰', async () => {
    db.memoryEnabled = false;
    db.readRows = [memoryRow({ content: '我在用 Next.js 14' })];

    await write('我在用 Next.js 15。');

    expect(db.creates).toEqual([]);
    expect(db.revises).toEqual([]);
  });

  it('同一轮里同一行只演化一次，连着两个新说法不会抢同一个旧行', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ content: '我在用 Next.js 14' })];

    await write('我在用 Next.js 15。我在用 Next.js 16。');

    expect(db.revises).toHaveLength(1);
    expect(db.revises[0].previousId).toBe('mem-1');
    expect(db.creates).toEqual([]);
  });

  it('演化也占每轮写入名额，第三条候选会被名额挡掉', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ content: '我在用 Next.js 14' })];

    await write('我在用 Next.js 15。我住在杭州。我喜欢喝温水。');

    expect(db.revises).toHaveLength(1);
    expect(db.creates).toHaveLength(1);
    expect(db.creates[0].content).toBe('我住在杭州');
  });

  it('演化原因只说明为什么改，不带新旧正文', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ content: '我在用 Next.js 14' })];

    await write('我在用 Next.js 15。');

    const reason = String(db.revises[0].reason);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toContain('Next.js');
    expect(reason).not.toContain('14');
  });
});

describe('暂停长期记忆写入（任务书 7.3 的第五臂）', () => {
  it('暂停时一行都不落，也不记证据：新建、演化、派生记账全在闸门之后', async () => {
    db.memoryEnabled = true;
    db.memoryWritePaused = true;
    // 库里已有同一件事的旧说法 ⇒ 不暂停时这一句本该走演化，而不是新建。
    db.readRows = [memoryRow()];

    await write('我在用 Prisma 1.0 和 Next.js。');

    expect(db.creates).toEqual([]);
    expect(db.revises).toEqual([]);
    expect(db.evidenceCalls).toEqual([]);
  });

  it('暂停时写侧一次数据库读都不发生：排除表、策略、已有记忆都不问', async () => {
    db.memoryEnabled = true;
    db.memoryWritePaused = true;
    db.readRows = [memoryRow()];

    await write('我在用 Next.js 15 和 Prisma。');

    // 8.3 那句「关闭模块后，不能继续执行对应的数据读取、生成和后台写入」在这一臂上字面成立。
    // 所以这一条断言的是「没问」，不是「问了但没写」——闸门必须在所有读之前。
    expect(db.exclusionCalls).toEqual([]);
    expect(db.policyCalls).toBe(0);
    expect(db.listFilters).toEqual([]);
  });

  it('暂停只管记、不管用：已存的记忆照常注入提示词', async () => {
    db.memoryEnabled = true;
    db.memoryWritePaused = true;
    db.readRows = [memoryRow()];

    // 走 runCognitiveReads 而不是直接 call memoryModule.read：读侧的开关根本不在模块里，
    // 而在 manager 的模块闸门上。绕过闸门就测不到「暂停把读一起挡掉」这类越界改动。
    ensureCognitiveModules();
    const result = await runCognitiveReads({ ...TURN, content: '在吗' });

    // 「记住但先别带入」是关模块，「先别记、带着已有的接着用」是暂停——两件事必须分得开。
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.text).toContain('我在用 Prisma');
  });

  it('没暂停时和今天一样：闸门不许把开着的那条路也变慢', async () => {
    db.memoryEnabled = true;
    db.memoryWritePaused = false;

    await write('我在用 Next.js 15 和 Prisma。');

    expect(db.creates).toHaveLength(1);
    expect(db.exclusionCalls).toEqual(['user-a']);
    expect(db.policyCalls).toBe(1);
  });
});

describe('读侧：记忆作为数据进提示词', () => {
  it('开关关着时不读，也不产生任何注入块', async () => {
    db.memoryEnabled = false;
    db.readRows = [memoryRow()];

    ensureCognitiveModules();
    const result = await runCognitiveReads({ ...TURN, content: '在吗' });

    expect(result.blocks).toEqual([]);
    expect(db.listFilters).toEqual([]);
  });

  it('开关打开后注入块标明「这是数据不是指令」，并带上类型、情境和来源', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];

    const blocks = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.module).toBe('memory');
    expect(blocks[0]?.label).toBe('长期记忆');
    expect(blocks[0]?.text).toContain('不是指令');
    expect(blocks[0]?.text).toContain('我在用 Prisma');
    expect(blocks[0]?.text).toContain('项目');
    expect(blocks[0]?.text).toContain('技术项目');
    expect(blocks[0]?.text).toContain('亲口说');
  });

  it('情绪行的三档真的挂在读路径上：off 不带入、explicit 报条数、默认与今天一样', async () => {
    db.memoryEnabled = true;
    db.readRows = [
      memoryRow({ id: 'mem-mood', type: 'emotion', content: '最近一想到汇报就发紧' }),
      memoryRow({ id: 'mem-tech', content: '我在用 Prisma' })
    ];

    const off = await memoryModule.read({ ...TURN, content: '在吗', emotionTransparency: 'off' });
    const implicit = await memoryModule.read({ ...TURN, content: '在吗' });
    const explicit = await memoryModule.read({ ...TURN, content: '在吗', emotionTransparency: 'explicit' });

    // off 是「连看都不看」：正文不进 text，id 也不进引用清单。
    expect(off[0]?.text).not.toContain('发紧');
    expect(off[0]?.memoryIds).toEqual(['mem-tech']);
    expect(implicit[0]?.text).toContain('发紧');
    expect(explicit[0]?.text).toContain('其中 1 条与情绪有关');
    // 没传档位 = 库里的默认档 = 改造前的形状，一个字都不许多。
    expect(implicit[0]?.text).not.toContain('与情绪有关');
  });

  it('用户在设置页选的那一档，走到这一轮的提示词里', async () => {
    db.memoryEnabled = true;
    // 片U 之后情绪类内容要先过总闸才谈得上档位，所以这一条把闸门开到 true；
    // 它钉的是「偏好行 → 引擎 → 渲染」这条链，不是闸门本身（闸门有自己那两条）。
    db.emotionEnabled = true;
    db.emotionTransparency = 'explicit';
    db.readRows = [memoryRow({ id: 'mem-mood', type: 'emotion', content: '最近一想到汇报就发紧' })];

    ensureCognitiveModules();
    const result = await runCognitiveReads({ ...TURN, content: '在吗' });

    // 这一条钉的是整条链：偏好行 → 引擎交给模块 → 渲染。中间任何一环把档位丢掉，这里就静默回到旧档。
    expect(result.blocks[0]?.text).toContain('其中 1 条与情绪有关');
  });

  it('没有记忆时不注入空块', async () => {
    db.memoryEnabled = true;
    db.readRows = [];

    expect(await memoryModule.read({ ...TURN, content: '在吗' })).toEqual([]);
  });

  it('读的时候按「此刻有效」过滤，并且只读自己的', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];

    await memoryModule.read({ ...TURN, content: '在吗' });

    expect(db.listFilters[0]).toMatchObject({
      userId: 'user-a',
      filters: { asOf: expect.any(Date), take: MEMORY_RETRIEVAL_POOL }
    });
  });

  it('精度未知时不显示时间，精度是年时只显示年', async () => {
    db.memoryEnabled = true;
    db.readRows = [
      memoryRow({ id: 'mem-1', content: '我在用 Prisma' }),
      memoryRow({
        id: 'mem-2',
        content: '我住在杭州',
        type: 'fact',
        context: 'general',
        precision: 'year',
        validFrom: '2026-01-01T00:00:00.000Z'
      })
    ];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('2026年');
    expect(block?.text).not.toContain('时间未知');
    expect(block?.text).not.toMatch(/2026年1月1日/);
  });

  it('条数和字数都有上限，长会话不会把提示词撑爆', async () => {
    db.memoryEnabled = true;
    db.readRows = Array.from({ length: 30 }, (_, index) =>
      memoryRow({ id: `mem-${index}`, content: `第 ${index} 条记忆，内容挺长的`.padEnd(120, '字') })
    );

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });
    const lines = (block?.text ?? '').split('\n').filter((line) => line.startsWith('- '));

    expect(lines.length).toBeLessThanOrEqual(MEMORY_READ_MAX_ITEMS);
    expect((block?.text ?? '').length).toBeLessThanOrEqual(MEMORY_READ_MAX_CHARS);
  });

  it('检索设置调低到 3 条时，读侧真的只注入 3 条（任务书 8.3）', async () => {
    db.memoryEnabled = true;
    db.memoryReadLimit = 3;
    db.readRows = Array.from({ length: 20 }, (_, index) =>
      memoryRow({ id: `mem-${index}`, content: `第 ${index} 条记忆，内容够短` })
    );

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });
    const lines = (block?.text ?? '').split('\n').filter((line) => line.startsWith('- '));

    expect(lines).toHaveLength(3);
  });

  it('关联开关开着时才问关系表，扩展行进同一个注入块（任务书 3.2 的接线）', async () => {
    db.memoryEnabled = true;
    db.associationEnabled = true;
    db.readRows = [memoryRow()];
    db.expandHits = [
      {
        memory: memoryRow({ id: 'hop-1', content: '上次爬山也带了相机' }),
        hop: 1,
        relationType: 'SAME_TOPIC',
        viaMemoryId: 'mem-1',
        viaSnippet: '我在用 Prisma'
      }
    ];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(db.expandCalls).toHaveLength(1);
    expect(block?.text).toContain('相关记忆');
    expect(block?.text).toContain('上次爬山也带了相机');
    expect(block?.memoryIds).toContain('hop-1');
  });

  it('关联扩展行进提示词时也吃可信度标注：由关系边捞进来的低凭据记忆不得光秃秃出现', async () => {
    db.memoryEnabled = true;
    db.associationEnabled = true;
    db.band = 'low';
    db.readRows = [memoryRow()];
    db.expandHits = [
      {
        memory: memoryRow({ id: 'hop-1', content: '上次爬山也带了相机' }),
        hop: 1,
        relationType: 'SAME_TOPIC',
        viaMemoryId: 'mem-1',
        viaSnippet: '我在用 Prisma'
      }
    ];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    const relatedLine = (block?.text ?? '').split('\n').find((line) => line.includes('上次爬山也带了相机'));
    expect(relatedLine).toContain('可信度低');
  });

  it('字符预算把换行符也算进去：贴边时整块不越 MEMORY_READ_MAX_CHARS', () => {
    const confidenceOf = (band: 'low' | 'medium' | 'high') =>
      new Map([['mem-1', { score: 0.6, band, factors: [] }]]) as never;
    // 用探针块反推出表头和行前缀的真实长度，不硬编码标签文案。
    const probe = renderMemoryBlock([memoryRow({ content: '甲' }) as MemoryDto], confidenceOf('high'))[0].text;
    const [header, probeLine] = probe.split('\n');
    const prefix = probeLine.slice(0, -'甲'.length);
    const atEdge = MEMORY_READ_MAX_CHARS - header.length - prefix.length;

    // 正文恰好顶到「不含换行」的旧预算：旧实现放行、整块实际 1501 字；现在这一条必须丢。
    expect(renderMemoryBlock([memoryRow({ content: '字'.repeat(atEdge) }) as MemoryDto], confidenceOf('high'))).toEqual([]);
    // 短一个字符则放行，且整块（含换行）刚好不越预算。
    const fits = renderMemoryBlock([memoryRow({ content: '字'.repeat(atEdge - 1) }) as MemoryDto], confidenceOf('high'))[0].text;
    expect(fits.length).toBeLessThanOrEqual(MEMORY_READ_MAX_CHARS);
  });

  it('关联开关关着时一次都不问关系表，注入块和加这一片之前一样', async () => {
    db.memoryEnabled = true;
    db.associationEnabled = false;
    db.readRows = [memoryRow()];
    db.expandHits = [
      {
        memory: memoryRow({ id: 'hop-1', content: '上次爬山也带了相机' }),
        hop: 1,
        relationType: 'SAME_TOPIC',
        viaMemoryId: 'mem-1',
        viaSnippet: '我在用 Prisma'
      }
    ];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(db.expandCalls).toEqual([]);
    expect(block?.text).not.toContain('相关记忆');
    expect(block?.memoryIds).toEqual(['mem-1']);
  });

  it('重复注册不会让同一段记忆注入两次', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];
    ensureCognitiveModules();

    const result = await runCognitiveReads({ ...TURN, content: '在吗' });

    expect(result.blocks.filter((block) => block.module === 'memory')).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });

  it('内置默认策略和读侧渲染用的是同一套情境与类型名称', () => {
    expect(DEFAULT_MEMORY_POLICIES.technicalProject.allowPersistence).toBe(true);
    expect(DEFAULT_MEMORY_POLICIES.emotionalSupport.allowPersistence).toBe(false);
  });
});

/**
 * ① 保留期在读侧真正生效。
 *
 * 这一组钉的是「策略里的保留期不是装饰」：过了期限的记忆不再进入对话，
 * 但读侧过滤≠删除——行还在库里，管理界面照样能看到并撤回。
 * 反面同样要钉住：不能因为前面几条过期就把还在保留期内的记忆一起丢掉。
 */
describe('读侧：保留期决定还能不能被用', () => {
  it('保留期 30 天时，40 天前的记忆不再注入，10 天前的照旧注入', async () => {
    db.memoryEnabled = true;
    db.policies = withRetention('days30');
    db.readRows = [
      memoryRow({ id: 'mem-new', content: '我在用 Next.js 15', recordedAt: isoDaysAgo(10) }),
      memoryRow({ id: 'mem-old', content: '我在用 Next.js 14', recordedAt: isoDaysAgo(40) })
    ];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('我在用 Next.js 15');
    expect(block?.text).not.toContain('我在用 Next.js 14');
  });

  it('长期保留时几年前的记忆仍然注入', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ content: '我在用 Prisma', recordedAt: isoDaysAgo(900) })];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('我在用 Prisma');
  });

  it('只在当次对话的记忆，换一次对话就不注入', async () => {
    db.memoryEnabled = true;
    db.policies = withRetention('sessionOnly');
    db.readRows = [memoryRow({ content: '这段只属于那次对话', chatId: 'chat-1', recordedAt: isoDaysAgo(0) })];

    const here = await memoryModule.read({ ...TURN, content: '在吗' });
    const elsewhere = await memoryModule.read({ ...TURN, chatId: 'chat-2', content: '在吗' });

    expect(here[0]?.text).toContain('这段只属于那次对话');
    expect(elsewhere).toEqual([]);
  });

  it('默认策略下敏感情境就是只在当次对话：默认值本身就守得住', async () => {
    db.memoryEnabled = true;
    db.readRows = [
      memoryRow({
        id: 'mem-s',
        content: '我最近很焦虑',
        type: 'emotion',
        context: 'emotionalSupport',
        chatId: 'chat-1',
        recordedAt: isoDaysAgo(3)
      })
    ];

    const here = await memoryModule.read({ ...TURN, content: '在吗' });
    const elsewhere = await memoryModule.read({ ...TURN, chatId: 'chat-2', content: '在吗' });

    expect(here[0]?.text).toContain('我最近很焦虑');
    expect(elsewhere).toEqual([]);
  });

  it('前面的记忆都过期时，后面还在保留期内的仍能被顶上来', async () => {
    db.memoryEnabled = true;
    db.policies = withRetention('days30');
    // 只用 9 条过期行：够证明「过期行不再占掉可用行的名额」（改造前按 take=8 会把这条切掉），
    // 又不假装候选池是无限的——池子的上限就是服务层允许的 MEMORY_RETRIEVAL_POOL 行。
    const expired = Array.from({ length: MEMORY_READ_MAX_ITEMS + 1 }, (_, index) =>
      memoryRow({ id: `old-${index}`, content: `过期记忆 ${index}`, recordedAt: isoDaysAgo(60) })
    );
    db.readRows = [...expired, memoryRow({ id: 'fresh', content: '还在保留期内', recordedAt: isoDaysAgo(1) })];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('还在保留期内');
    expect(block?.text).not.toContain('过期记忆');
  });

  it('注入条数仍按 MEMORY_READ_MAX_ITEMS 截断，过滤不放大上限', async () => {
    db.memoryEnabled = true;
    db.readRows = Array.from({ length: MEMORY_RETRIEVAL_POOL }, (_, index) =>
      memoryRow({ id: `mem-${index}`, content: `第 ${index} 条`, recordedAt: isoDaysAgo(1) })
    );

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });
    const lines = (block?.text ?? '').split('\n').filter((line) => line.startsWith('- '));

    expect(lines).toHaveLength(MEMORY_READ_MAX_ITEMS);
  });

  it('一条记忆都没有时不去查策略表', async () => {
    db.memoryEnabled = true;
    db.readRows = [];

    await memoryModule.read({ ...TURN, content: '在吗' });

    expect(db.policyCalls).toBe(0);
  });

  it('保留期只影响读侧：过期的旧说法仍然是改口的落点，不会再落一条重复的', async () => {
    db.memoryEnabled = true;
    db.policies = withRetention('days30');
    db.readRows = [memoryRow({ content: '我在用 Next.js 14', recordedAt: isoDaysAgo(40) })];

    await write('我在用 Next.js 15。');

    expect(db.creates).toEqual([]);
    expect(db.revises).toHaveLength(1);
    expect(db.revises[0]).toMatchObject({ previousId: 'mem-1' });
  });
});

/**
 * ④b 来源排除规则（任务书 7.3）。用户永久删除过的那句话，下次再说不该被自动记回来——
 * 否则「忘掉这条」这个动作等于没做。匹配按归一化后的正文，不按 sourceMessageId：
 * 换一条消息重说同一件事，消息 id 就变了，按 id 排除等于什么都没排除。
 */
describe('写侧：永久删除过的内容不会被自动记回来', () => {
  it('命中排除表的候选既不新增也不演化', async () => {
    db.memoryEnabled = true;
    db.excluded = [exclusionHash('user-a', '我住在杭州')];

    await write('我住在杭州。');

    expect(db.creates).toEqual([]);
    expect(db.revises).toEqual([]);
  });

  it('换个大小写和标点也算命中，归一化和排除表用的是同一套', async () => {
    db.memoryEnabled = true;
    db.excluded = [exclusionHash('user-a', '我住在杭州')];

    await write('  我住在杭州。 ');

    expect(db.creates).toEqual([]);
  });

  it('没被排除的内容照常落库，排除不许扩大到别的话', async () => {
    db.memoryEnabled = true;
    db.excluded = [exclusionHash('user-a', '我住在杭州')];

    await write('我在用 Prisma。');

    expect(db.creates).toHaveLength(1);
  });

  it('别人的排除不影响自己', async () => {
    db.memoryEnabled = true;
    db.excluded = [exclusionHash('user-b', '我住在杭州')];

    await write('我住在杭州。');

    expect(db.creates).toHaveLength(1);
  });

  it('撤销排除之后，同一句话可以重新被记住', async () => {
    db.memoryEnabled = true;
    db.excluded = [exclusionHash('user-a', '我住在杭州')];
    await write('我住在杭州。');
    expect(db.creates).toEqual([]);

    db.excluded = [];
    await write('我住在杭州。');

    expect(db.creates).toHaveLength(1);
  });

  it('这一轮没有候选时不查排除表，白问一次数据库也是开销', async () => {
    db.memoryEnabled = true;

    await write('你好');

    expect(db.exclusionCalls).toEqual([]);
  });

  it('关掉长期记忆时连排除表都不查', async () => {
    db.memoryEnabled = false;

    await write('我住在杭州。');

    expect(db.exclusionCalls).toEqual([]);
    expect(db.creates).toEqual([]);
  });
});

/**
 * ③ 关键词召回。改造前读侧是按 recordedAt 倒序取前 8 条，和用户这一轮问什么完全无关。
 * 这一组钉的是：相关的旧记忆能被顶上来、无关的新记忆会被挤下去、
 * 以及一个都匹配不上时退回时间顺序（不许比改造前更差）。
 */
describe('读侧：按这一轮的提问召回，不是按时间倒序', () => {
  const now = Date.now();

  /** 8 条最近的无关记忆，用来占满注入名额：相关的那条必须真把它们挤掉才算数。 */
  function filler() {
    return Array.from({ length: MEMORY_READ_MAX_ITEMS }, (_, index) =>
      memoryRow({
        id: `filler-${index}`,
        content: `无关的填充内容 ${index}`,
        recordedAt: new Date(now - index * 1000).toISOString()
      })
    );
  }

  it('最旧的那条只要相关，也能挤掉最近的无关记忆', async () => {
    db.memoryEnabled = true;
    db.readRows = [...filler(), memoryRow({ id: 'relevant', content: '我住在杭州', recordedAt: isoDaysAgo(300) })];

    const [block] = await memoryModule.read({ ...TURN, content: '我住在哪个城市来着？' });

    expect(block?.text).toContain('我住在杭州');
    expect(block?.text).not.toContain(`无关的填充内容 ${MEMORY_READ_MAX_ITEMS - 1}`);
  });

  it('查询词就是用户这一轮说的话：同一批记忆，问法不同召回的就不同', async () => {
    db.memoryEnabled = true;
    db.readRows = [
      ...filler(),
      memoryRow({ id: 'exam', content: '我打算明年考研', recordedAt: isoDaysAgo(300) }),
      memoryRow({ id: 'db', content: '我在用 Prisma', recordedAt: isoDaysAgo(301) })
    ];

    const [aboutExam] = await memoryModule.read({ ...TURN, content: '考研的事我怎么说的' });
    const [aboutDb] = await memoryModule.read({ ...TURN, content: 'Prisma 还在用吗' });

    expect(aboutExam?.text).toContain('我打算明年考研');
    expect(aboutExam?.text).not.toContain('我在用 Prisma');
    expect(aboutDb?.text).toContain('我在用 Prisma');
    expect(aboutDb?.text).not.toContain('我打算明年考研');
  });

  it('一个问题都匹配不上时退回时间倒序，不会一条都不给', async () => {
    db.memoryEnabled = true;
    db.readRows = [
      memoryRow({ id: 'm1', content: '我在用 Prisma', recordedAt: isoDaysAgo(1) }),
      memoryRow({ id: 'm2', content: '我住在杭州', recordedAt: isoDaysAgo(2) })
    ];

    const [block] = await memoryModule.read({ ...TURN, content: 'zzz qqq' });

    expect(block?.text).toContain('我在用 Prisma');
    expect(block?.text).toContain('我住在杭州');
  });

  it('候选池放开到服务层上限，不再只看最近那几条', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];

    await memoryModule.read({ ...TURN, content: '在吗' });

    expect(db.listFilters[0]).toMatchObject({
      userId: 'user-a',
      filters: { asOf: expect.any(Date), take: MEMORY_RETRIEVAL_POOL }
    });
    expect(MEMORY_RETRIEVAL_POOL).toBeGreaterThan(MEMORY_READ_MAX_ITEMS);
  });
});

/**
 * 1a 证据账本接线（任务书 2.2）。
 *
 * 写侧：同一句话被用户再说一遍，此前是直接丢掉的（`known.has(key)` 就 continue）。
 * 但「换了个对话又说一遍」是一次独立陈述，正是置信度要数的那个东西；
 * 同一个对话里再说一遍只是强调，不算独立证据——否则一段啰嗦的话就能把自己抬成高可信。
 *
 * 读侧：低档位的记忆必须标出来。任务书 3.3 要求「置信度不足时不得以确定性语气联想」，
 * 而模型看得到的是这段文本，所以标注只能写在这段文本里。
 */
describe('写侧：重复陈述记成独立证据', () => {
  it('同一句话在另一个对话里再说一遍，记一条支持证据，既不新增也不演化', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ chatId: 'chat-1' })];

    await memoryModule.write!({
      ...TURN,
      chatId: 'chat-2',
      sourceMessageId: 'msg-2',
      content: '我在用 Prisma。',
      occurredAt: OCCURRED
    });

    expect(db.creates).toEqual([]);
    expect(db.revises).toEqual([]);
    expect(db.evidenceCalls).toEqual([
      {
        userId: 'user-a',
        memoryId: 'mem-1',
        kind: 'supports',
        origin: 'explicit',
        sourceMessageId: 'msg-2',
        sourceChatId: 'chat-2'
      }
    ]);
  });

  it('同一个对话里再说一遍不算独立证据，那只是强调', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ chatId: 'chat-1' })];

    await write('我在用 Prisma。');

    expect(db.evidenceCalls).toEqual([]);
    expect(db.creates).toEqual([]);
  });

  it('关掉长期记忆时连证据都不记', async () => {
    db.memoryEnabled = false;
    db.readRows = [memoryRow({ chatId: 'chat-1' })];

    await memoryModule.write!({ ...TURN, chatId: 'chat-2', content: '我在用 Prisma。', occurredAt: OCCURRED });

    expect(db.evidenceCalls).toEqual([]);
  });

  it('记证据失败不影响这一轮剩下的候选：那是附带效果，不是主写入', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow({ chatId: 'chat-1' })];
    db.evidenceThrows = true;

    await memoryModule.write!({
      ...TURN,
      chatId: 'chat-2',
      sourceMessageId: 'msg-2',
      content: '我在用 Prisma。我住在杭州。',
      occurredAt: OCCURRED
    });

    // 第一句是重复陈述（记证据，失败被吞掉），第二句该照常落库
    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]?.content).toBe('我住在杭州');
  });
});

describe('读侧：低可信度的记忆要标出来', () => {
  it('低档位的记忆带上「不得以确定性语气使用」', async () => {
    db.memoryEnabled = true;
    db.band = 'low';
    db.readRows = [memoryRow()];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('（可信度低，不得以确定性语气使用）');
  });

  it('中高档位不加标注，免得每行都挂一句免责', async () => {
    db.memoryEnabled = true;
    db.band = 'high';
    db.readRows = [memoryRow()];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).not.toContain('可信度低');
  });

  it('一批记忆只算一次置信度，不是每条各查一次', async () => {
    db.memoryEnabled = true;
    db.readRows = [
      memoryRow({ id: 'mem-1' }),
      memoryRow({ id: 'mem-2', content: '我住在杭州' }),
      memoryRow({ id: 'mem-3', content: '我在学 Rust' })
    ];

    await memoryModule.read({ ...TURN, content: '在吗' });

    expect(db.assessCalls).toEqual(['user-a']);
  });

  it('算不出置信度时按低档位处理，宁可多标一句也不冒充确定', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];
    db.assessReturnsEmpty = true;

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('（可信度低，不得以确定性语气使用）');
  });
});

/** 片U 的第二把锁：情绪类内容进不进长期库，还归各情境的「允许记住的类型」管。 */
function withEmotionType() {
  return {
    ...DEFAULT_MEMORY_POLICIES,
    general: {
      ...DEFAULT_MEMORY_POLICIES.general,
      allowedMemoryTypes: [...DEFAULT_MEMORY_POLICIES.general.allowedMemoryTypes, 'emotion' as const]
    }
  };
}

describe('情绪总开关 emotionEnabled：写侧闸门与引擎读侧闸门（片U）', () => {
  it('闸门关着时情绪句一行都不落，也不进待确认候选——今天线上就是这个形状', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = false;
    // 连「策略放开情绪」这种最容易漏的情况也一起铺上：闸门若在抽取之前不生效，这一条会落库。
    db.policies = withEmotionType();

    await write('我今天心里很烦。');

    expect(db.creates).toEqual([]);
    expect(db.proposals).toEqual([]);
  });

  it('闸门打开、而且那个情境勾了「情绪」这一类，才落库：落的是原话，来源是亲口说', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = true;
    db.policies = withEmotionType();

    await write('我今天心里很烦。');

    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({
      type: 'emotion',
      context: 'general',
      origin: 'explicit',
      content: '我今天心里很烦'
    });
  });

  it('闸门打开但策略没放开情绪类型时仍一行都不落：第二把锁归策略表管', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = true;

    await write('我今天心里很烦。');

    expect(db.creates).toEqual([]);
    expect(db.proposals).toEqual([]);
  });

  it('闸门打开只让这句话进候选，不越权改写其它类型：同轮的偏好句照旧按偏好落', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = true;
    db.policies = withEmotionType();

    await write('我不喜欢周三开会。我今天心里很烦。');

    expect(db.creates.map((row) => row.type)).toEqual(['preference', 'emotion']);
  });

  it('走引擎的读侧：闸门关着时库里已有的情绪行不端给模型，也不进引用清单', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = false;
    db.readRows = [
      memoryRow({ id: 'mem-mood', type: 'emotion', content: '最近一想到汇报就发紧' }),
      memoryRow({ id: 'mem-tech', content: '我在用 Prisma' })
    ];

    ensureCognitiveModules();
    const result = await runCognitiveReads({ ...TURN, content: '在吗' });

    expect(result.blocks[0]?.text).not.toContain('发紧');
    expect(result.blocks[0]?.memoryIds).toEqual(['mem-tech']);
    expect(result.blocks[0]?.text).toContain('我在用 Prisma');
  });

  it('走引擎的读侧：闸门打开后情绪行才轮到三档说话', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = true;
    db.emotionTransparency = 'explicit';
    db.readRows = [memoryRow({ id: 'mem-mood', type: 'emotion', content: '最近一想到汇报就发紧' })];

    ensureCognitiveModules();
    const result = await runCognitiveReads({ ...TURN, content: '在吗' });

    expect(result.blocks[0]?.text).toContain('最近一想到汇报就发紧');
    expect(result.blocks[0]?.text).toContain('其中 1 条与情绪有关');
    expect(result.blocks[0]?.memoryIds).toEqual(['mem-mood']);
  });

  it('没走引擎的直接调用不看这个闸门：缺席＝今天的形状（评测 Harness 走的就是这一条）', async () => {
    db.memoryEnabled = true;
    db.emotionEnabled = false;
    db.readRows = [memoryRow({ id: 'mem-mood', type: 'emotion', content: '最近一想到汇报就发紧' })];

    const [block] = await memoryModule.read({ ...TURN, content: '在吗' });

    expect(block?.text).toContain('最近一想到汇报就发紧');
  });
});
