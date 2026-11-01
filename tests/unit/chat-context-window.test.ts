import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@prisma/client';

/**
 * buildConversation 原来的窗口是 `orderBy createdAt asc, take 60` 再 `slice(-40)`：
 * 超过 60 条的会话捞到的是最早的 60 条，截出来的还是最早那批——模型看到的上下文
 * 停留在会话开头，而且白搬 20 条密文。这里钉住「最近 40 条」。
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
    message: {
      findMany: (args: Record<string, any>) => {
        ctx.queries.push(args);
        const desc = orderOf(args) === 'desc';
        const ordered = [...ctx.rows].sort((a, b) =>
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
async function seed(count: number, current: string) {
  const { encryptMessage } = await import('@/lib/chats');
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `msg-${i}`;
    const isLast = i === count;
    rows.push({
      id,
      chatId: 'chat-1',
      role: isLast || i % 2 === 1 ? 'USER' : 'ASSISTANT',
      contentCiphertext: encryptMessage(isLast ? current : textAt(i), id),
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

async function build(current = CURRENT) {
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
  return texts(
    await buildConversation({
      chatId: 'chat-1',
      userId: 'user-1',
      currentContent: current,
      attachments: [],
      provider
    })
  );
}

describe('发给模型的历史窗口', () => {
  beforeEach(() => {
    ctx.rows = [];
    ctx.queries = [];
  });

  it('一百条消息的会话带最近一窗，开头那条不会出现在上下文里', async () => {
    await seed(101, CURRENT);

    const out = await build();
    const joined = out.join('\n');

    expect(joined).toContain('m-100');
    expect(joined).not.toContain('m-001');
    expect(joined).not.toContain('m-060');
  });

  it('窗口正好是最近 40 条（含本轮这条），起点是最旧的被保留消息', async () => {
    await seed(101, CURRENT);

    const out = await build();
    const history = out.slice(1, -1);

    expect(out).toHaveLength(41);
    expect(out[0]).toContain('家庭 AI 助手');
    expect(history).toHaveLength(39);
    expect(history[0]).toBe(textAt(62));
    expect(history[38]).toBe(textAt(100));
    expect(out[40]).toBe(CURRENT);
  });

  it('取窗口时向最近一端取，不会为了 40 条先捞 60 条', async () => {
    await seed(101, CURRENT);

    await build();

    expect(ctx.queries[0].take).toBeLessThanOrEqual(40);
    expect(orderOf(ctx.queries[0])).toBe('desc');
  });

  it('短会话全部带上', async () => {
    await seed(3, CURRENT);

    const out = await build();

    expect(out).toEqual([expect.stringContaining('家庭 AI 助手'), textAt(1), textAt(2), CURRENT]);
  });

  it('长会话不丢本轮那条用户消息', async () => {
    await seed(120, CURRENT);

    const out = await build();

    expect(out[out.length - 1]).toBe(CURRENT);
  });
});
