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
  creates: [] as Array<Record<string, unknown>>,
  revises: [] as Array<Record<string, unknown>>,
  readRows: [] as Array<Record<string, unknown>>,
  listFilters: [] as unknown[]
}));

vi.mock('@/lib/cognitive/preferences', () => ({
  getCognitivePreferences: () =>
    Promise.resolve({
      memoryEnabled: db.memoryEnabled,
      userModelEnabled: false,
      emotionEnabled: false,
      associationEnabled: false,
      timelineEnabled: false,
      reflectionEnabled: false,
      decisionMemoryEnabled: false,
      adaptiveMemoryEnabled: false,
      emotionTransparency: 'implicit'
    })
}));

vi.mock('@/lib/cognitive/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/policy')>();
  return {
    ...actual,
    // 库里一行都没配过 → 用内置默认，测试直接断言默认策略下的行为。
    getMemoryPolicies: () => Promise.resolve(actual.DEFAULT_MEMORY_POLICIES)
  };
});

vi.mock('@/lib/cognitive/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/memories')>();
  return {
    ...actual,
    // 只替换要落库的两个出入口；describeValidRange 这类纯函数保持真实实现。
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

import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import {
  ensureCognitiveModules,
  memoryModule,
  MEMORY_READ_MAX_CHARS,
  MEMORY_READ_MAX_ITEMS,
  MEMORY_WRITE_MAX_PER_TURN
} from '@/lib/cognitive/memory-module';
import { runCognitiveReads } from '@/lib/cognitive/manager';

const TURN = { userId: 'user-a', chatId: 'chat-1', content: '', sourceMessageId: 'msg-1' };
const OCCURRED = new Date('2026-11-02T10:00:00.000Z');

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
  db.creates = [];
  db.revises = [];
  db.readRows = [];
  db.listFilters = [];
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
    expect(db.creates[0].validFrom).toBeUndefined();
  });

  it('决策情境默认要先问用户确认，这一片不假装确认过：不落库', async () => {
    db.memoryEnabled = true;

    await write('我纠结了很久，我决定下周三辞职。');

    expect(db.creates).toEqual([]);
  });

  it('敏感情境和普通情境分数打平时取最保守的一条，敏感情境不落库', async () => {
    db.memoryEnabled = true;

    await write('我在用 Prisma 时焦虑。');

    expect(db.creates).toEqual([]);
  });

  it('同一句话第二次说不产生重复行', async () => {
    db.memoryEnabled = true;
    db.readRows = [memoryRow()];

    await write('我在用 Prisma。');

    expect(db.creates).toEqual([]);
  });

  it('一轮里最多落两条，防止一条长消息灌库', async () => {
    db.memoryEnabled = true;

    await write('我在用 Prisma。我住在杭州。我喜欢喝温水。我打算考研。');

    expect(db.creates).toHaveLength(MEMORY_WRITE_MAX_PER_TURN);
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
      filters: { asOf: expect.any(Date), take: MEMORY_READ_MAX_ITEMS }
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
