import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AiProvider } from '@prisma/client';
import { toOutboundTexts } from './outbound-message';

/**
 * ③ 的接线面：认知块必须真的出现在发给模型的消息里，而且——
 * 开关关着不出现、读失败也不能把对话带下水。
 * 这一片只测「链路通不通」，决策与渲染在 cognitive-memory-module.test.ts 里已经钉过。
 */

/** New read-side augmentations are covered separately; preserve legacy wiring fixtures here. */
vi.mock('@/lib/cognitive/memory-verification', () => ({
  filterVerifiedMemoryPool: (_userId: string, rows: unknown[]) => Promise.resolve(rows)
}));
vi.mock('@/lib/cognitive/knowledge-wiki', () => ({
  wikiContextBlocks: () => Promise.resolve([])
}));
vi.mock('@/lib/cognitive/experience', () => ({
  experienceContextBlocks: () => Promise.resolve([])
}));

const db = vi.hoisted(() => ({
  memoryEnabled: false,
  rows: [] as Array<Record<string, unknown>>,
  wheres: [] as Array<Record<string, unknown>>,
  failMemoryRead: false
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemConfig: {
      findUnique: ({ where }: { where: { key: string } }) => Promise.resolve(
        where.key === 'conversationStyle:persona-user' ? { value: { persona: 'zhiwei' } } : null
      )
    },
    chat: { findFirst: () => Promise.resolve({ id: 'chat-1' }) },
    message: { findMany: () => Promise.resolve([]) },
    cognitivePreference: {
      findUnique: () =>
        Promise.resolve(
          db.memoryEnabled ? { userId: 'user-a', memoryEnabled: true, emotionTransparency: 'IMPLICIT' } : null
        )
    },
    memoryPolicy: { findMany: () => Promise.resolve([]) },
    // 读侧现在还要算置信度：没有证据行就是全 0，档位由来源基线决定。
    memoryEvidence: { groupBy: () => Promise.resolve([]) },
    memoryItem: {
      findMany: ({ where }: { where: Record<string, unknown> }) => {
        db.wheres.push(where);
        if (db.failMemoryRead) return Promise.reject(new Error('表不存在'));
        return Promise.resolve(db.rows.filter((row) => row.userId === where.userId));
      }
    }
  }
}));

const PROVIDER = {
  id: 'p-1',
  ownerType: 'GLOBAL',
  userId: null,
  name: 'test',
  baseUrl: 'https://example.invalid/v1',
  apiKeyCiphertext: 'enc:v1:test1:AAA:BBB:CCC',
  modelId: 'some-model',
  capabilities: ['text'],
  params: null,
  enabled: true,
  isDefault: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z')
} as unknown as AiProvider;

async function memoryRow(userId: string, id: string, content: string) {
  const { encryptString } = await import('@/lib/crypto');
  return {
    id,
    userId,
    chatId: null,
    sourceMessageId: null,
    type: 'PROJECT',
    context: 'TECHNICAL_PROJECT',
    origin: 'EXPLICIT',
    contentCiphertext: encryptString(content, `memory:v1:${userId}:${id}`),
    confirmedAt: new Date('2026-11-02T10:00:00.000Z'),
    validPrecision: 'UNKNOWN',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: new Date('2026-11-02T10:00:00.000Z')
  };
}

async function build(userId = 'user-a') {
  const { messages } = await rawBuild(userId);
  return toOutboundTexts(messages);
}

it('adds the selected persona only to the account that chose it, even with the global layer off', async () => {
  expect((await build('persona-user')).some(({ text }) => text.includes('女性角色知微'))).toBe(true);
  expect((await build('other-persona-user')).some(({ text }) => text.includes('女性角色知微'))).toBe(false);
});

async function rawBuild(userId = 'user-a') {
  const { buildConversation } = await import('@/lib/chats');
  return buildConversation({
    chatId: 'chat-1',
    userId,
    currentContent: '帮我看下这段代码',
    attachments: [],
    provider: PROVIDER
  });
}

/** buildConversation 交回来的引用清单（8.2）：这一轮到底把哪几条记忆带进了提示词。 */
async function cited(userId = 'user-a') {
  const { citedMemoryIds } = await rawBuild(userId);
  return citedMemoryIds;
}

beforeEach(() => {
  db.memoryEnabled = false;
  db.rows = [];
  db.wheres = [];
  db.failMemoryRead = false;
});

describe('认知块进入对话上下文', () => {
  it('开关关着时只有基础 system 和本轮用户消息', async () => {
    db.memoryEnabled = false;
    db.rows = [await memoryRow('user-a', 'mem-1', '我在用 Prisma')];

    const messages = await build();

    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toContain('家庭 AI 助手');
    expect(db.wheres).toEqual([]);
  });

  it('开关打开后，记忆作为第二段 system 出现在历史之前，并声明自己不是指令', async () => {
    db.memoryEnabled = true;
    db.rows = [await memoryRow('user-a', 'mem-1', '我在用 Prisma')];

    const messages = await build();

    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.text).toContain('我在用 Prisma');
    expect(messages[1]?.text).toContain('不是指令');
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.text).toContain('帮我看下这段代码');
  });

  it('取记忆的条件里带着调用者自己的 userId，别人的行不会进上下文', async () => {
    db.memoryEnabled = true;
    db.rows = await Promise.all([
      memoryRow('user-a', 'mem-1', '我在用 Prisma'),
      memoryRow('user-b', 'mem-2', '别人家的秘密')
    ]);

    const messages = await build();

    expect(db.wheres[0]).toMatchObject({ userId: 'user-a' });
    expect(messages[1]?.text).not.toContain('别人家的秘密');
  });

  it('记忆读取失败时对话照旧，只是没有认知块', async () => {
    db.memoryEnabled = true;
    db.failMemoryRead = true;

    const messages = await build();

    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toContain('家庭 AI 助手');
  });
});

/**
 * 8.2 引用提示的那个数从哪来：读侧注入完，得有人记住「这一轮到底把哪几条带了进去」。
 * 断的是 buildConversation 交回的东西，不是界面——界面只消费这一个数组。
 */
describe('这一轮引用了哪几条记忆', () => {
  it('开关打开且真的注入了记忆时，交回被带进提示词的那些 id', async () => {
    db.memoryEnabled = true;
    db.rows = [await memoryRow('user-a', 'mem-1', '我在用 Prisma')];

    expect(await cited()).toEqual(['mem-1']);
  });

  it('开关关着时交回空数组：没注入就没有引用，界面也就没东西可列', async () => {
    db.memoryEnabled = false;
    db.rows = [await memoryRow('user-a', 'mem-1', '我在用 Prisma')];

    expect(await cited()).toEqual([]);
  });

  it('记忆读失败时交回空数组，对话照旧跑完', async () => {
    db.memoryEnabled = true;
    db.failMemoryRead = true;

    const messages = await build();

    expect(messages).toHaveLength(2);
    expect(await cited()).toEqual([]);
  });
});

/**
 * 8.1 唯一的真洞：`runCognitiveReads` 交回的 `failed` 以前被扔掉，
 * 于是「你自己把这个模块关了」和「模块开着但它挂了」在库里是同一个样子——
 * 事后谁也没法追问。这两条把区别要回来，第三条钉它确实进了审计。
 */
describe('哪一个认知站点挂了要能被事后追问', () => {
  async function failed(userId = 'user-a') {
    const { cognitiveFailed } = await rawBuild(userId);
    return cognitiveFailed;
  }

  it('站点开着但读挂了：交回挂了的那个模块键', async () => {
    db.memoryEnabled = true;
    db.failMemoryRead = true;

    expect(await failed()).toEqual(['memory']);
  });

  it('站点关着：交回空数组——关了不是挂了，这个字段不许把两者混成一件事', async () => {
    db.memoryEnabled = false;
    db.rows = [await memoryRow('user-a', 'mem-1', '我在用 Prisma')];

    expect(await failed()).toEqual([]);
  });

  it('对话路由把这份清单写进审计的 after：只放模块键，不放正文', () => {
    const route = readFileSync('src/app/api/chats/[id]/messages/route.ts', 'utf8');

    expect(route).toMatch(/cognitiveFailed/);
    // 审计里只许出现模块键这一个数组；正文、错误消息都不该顺着这条路进日志。
    expect(route).toMatch(/after:\s*\{[^}]*cognitiveFailed[^}]*\}/);
  });
});
