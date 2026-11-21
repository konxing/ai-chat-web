import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@prisma/client';

/**
 * 验证本轮消息之外的 128 条模型上下文，以及省略历史时的可见范围提示。
 * 密文用真实 crypto 模块生成，解密走真实路径。
 */
const ctx = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<Record<string, any>>
}));

function orderOf(query: Record<string, any>): string | undefined {
  return Array.isArray(query.orderBy) ? query.orderBy[0]?.createdAt : query.orderBy?.createdAt;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: {
      findFirst: () => Promise.resolve({ id: 'chat-1' })
    },
    // 认知开关读不到行＝全关，这两条用例只关心历史窗口，不该被认知层牵动。
    cognitivePreference: { findUnique: () => Promise.resolve(null) },
    message: {
      findMany: (args: Record<string, any>) => {
        ctx.queries.push(args);
        const desc = orderOf(args) === 'desc';
        const selected = ctx.rows.filter((row) => row.id !== args.where?.id?.not &&
          row.role !== args.where?.role?.not && row.status !== args.where?.status?.not);
        const ordered = selected.sort((a, b) =>
          desc
            ? (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
            : (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()
        );
        return Promise.resolve(ordered.slice(0, args.take));
      }
    }
  }
}));

function textAt(index: number) {
  return `m-${String(index).padStart(3, '0')} 这是第 ${index} 条消息`;
}

/** 造 count 条消息，最后一条是本轮刚写库的用户消息，内容就是 current。 */
async function seed(count: number, current: string, historicalText = textAt) {
  const { encryptMessage } = await import('@/lib/chats');
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `msg-${i}`;
    const isLast = i === count;
    rows.push({
      id,
      chatId: 'chat-1',
      role: isLast || i % 2 === 1 ? 'USER' : 'ASSISTANT',
      contentCiphertext: encryptMessage(isLast ? current : historicalText(i), id),
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000),
      status: 'COMPLETE'
    });
  }
  ctx.rows = rows;
}

const CURRENT = 'fresh question';

function texts(messages: Array<{ content: unknown }>) {
  return messages.map((m) =>
    typeof m.content === 'string'
      ? m.content
      : ((m.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')?.text ?? '')
  );
}

async function build(currentMessageId?: string) {
  const { buildConversation } = await import('@/lib/chats');
  const provider = {
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
  const { messages } = await buildConversation({
    chatId: 'chat-1',
    userId: 'user-1',
    currentMessageId,
    currentContent: CURRENT,
    attachments: [],
    provider
  });
  return texts(messages);
}

describe('发给模型的历史窗口', () => {
  beforeEach(() => {
    ctx.rows = [];
    ctx.queries = [];
  });

  it('一百条历史消息的会话仍能读取开头的内容', async () => {
    await seed(101, CURRENT);

    const out = await build();
    expect(out.slice(1, -1)).toEqual(Array.from({ length: 100 }, (_, i) => textAt(i + 1)));
    expect(out[0]).not.toContain('本轮历史范围');
    expect(out.at(-1)).toBe(CURRENT);
  });

  it('恰好 128 条历史加本轮消息，全文可见时没有省略提示', async () => {
    await seed(129, CURRENT);

    const out = await build('msg-129');

    expect(out.slice(1, -1)).toEqual(Array.from({ length: 128 }, (_, i) => textAt(i + 1)));
    expect(out[0]).not.toContain('本轮历史范围');
    expect(out.at(-1)).toBe(CURRENT);
  });

  it('超过窗口时从最近一端读取，用一个额外记录判断是否省略', async () => {
    await seed(143, CURRENT);
    const out = await build('msg-143');
    expect(ctx.queries[0].take).toBe(129);
    expect(orderOf(ctx.queries[0])).toBe('desc');
    expect(ctx.queries[0].where).toMatchObject({ chatId: 'chat-1', id: { not: 'msg-143' }, role: { not: 'SYSTEM' } });
    expect(out[0]).toContain('目前能看到的记录里找不到');
    expect(out.slice(1, -1)).toEqual(Array.from({ length: 128 }, (_, i) => textAt(i + 15)));
    expect(out.at(-1)).toBe(CURRENT);
  });

  it('短会话全部带上', async () => {
    await seed(3, CURRENT);

    const out = await build();

    expect(out).toEqual([expect.stringContaining('AI Chat 的对话助手'), textAt(1), textAt(2), CURRENT]);
  });

  it('没有传本轮 ID 时，已有同文消息也只发一次并保留前 128 条', async () => {
    await seed(129, CURRENT);
    const out = await build();
    expect(out[0]).not.toContain('本轮历史范围');
    expect(out.slice(1, -1)).toHaveLength(128);
    expect(out.filter((text) => text === CURRENT)).toHaveLength(1);
  });

  it('文本超过预算时，每个历史位置仍有内容，最近消息优先全文保留', async () => {
    const longText = (index: number) => `${textAt(index)} ${'🧪'.repeat(1000)} 末尾-${index}`;
    await seed(129, CURRENT, longText);
    const out = await build('msg-129');
    const history = out.slice(1, -1);
    expect(out[0]).toContain('部分聊天记录');
    expect(history).toHaveLength(128);
    expect(history.reduce((length, text) => length + text.length, 0)).toBeLessThanOrEqual(96_000);
    expect(history[0]).toContain(textAt(1));
    expect(history[0]).toContain('中间内容已省略');
    expect(history[0]).toContain('末尾-1');
    expect(history.at(-1)).toBe(longText(128));
    expect(history.every((text) => !/[\uD800-\uDFFF]/u.test(text))).toBe(true);
    expect(out.at(-1)).toBe(CURRENT);
  });
});
