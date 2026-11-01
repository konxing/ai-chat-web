import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@prisma/client';

/**
 * ④ 的前半段：一旦失败也往历史里落一条 status=ERROR 的助手消息，
 * 那条「模型服务认证失败」之类的文案就混在历史里。buildConversation 原来只跳
 * SYSTEM 角色，不看状态——失败文案会被当成上一轮回答喂回模型。
 * 这里钉住：ERROR 行不进上下文（连窗口名额都不该占），PARTIAL 行是真实内容，保留。
 */
const ctx = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<Record<string, any>>
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: {
      findFirst: () => Promise.resolve({ id: 'chat-1' })
    },
    message: {
      findMany: (args: Record<string, any>) => {
        ctx.queries.push(args);
        const excluded = args.where?.status?.not;
        const rows = excluded ? ctx.rows.filter((r) => r.status !== excluded) : ctx.rows;
        const desc = Array.isArray(args.orderBy) ? args.orderBy[0]?.createdAt === 'desc' : args.orderBy?.createdAt === 'desc';
        const ordered = [...rows].sort((a, b) =>
          desc
            ? (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
            : (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()
        );
        return Promise.resolve(ordered.slice(0, args.take));
      }
    }
  }
}));

const ERROR_TEXT = '模型服务认证失败，请检查 API Key';
const PARTIAL_TEXT = '这是被截断但真实存在的一半回答';

async function seed() {
  const { encryptMessage } = await import('@/lib/chats');
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const rows = [
    { id: 'm-1', role: 'USER', text: '第一个问题', status: 'COMPLETE' },
    { id: 'm-2', role: 'ASSISTANT', text: '第一个回答', status: 'COMPLETE' },
    { id: 'm-3', role: 'ASSISTANT', text: ERROR_TEXT, status: 'ERROR' },
    { id: 'm-4', role: 'ASSISTANT', text: PARTIAL_TEXT, status: 'PARTIAL' },
    { id: 'm-5', role: 'USER', text: '第二个问题', status: 'COMPLETE' }
  ];
  ctx.rows = rows.map((r, index) => ({
    id: r.id,
    chatId: 'chat-1',
    role: r.role,
    status: r.status,
    contentCiphertext: encryptMessage(r.text, r.id),
    createdAt: new Date(base + index * 1000)
  }));
}

async function build() {
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
  const out = await buildConversation({
    chatId: 'chat-1',
    userId: 'user-1',
    currentContent: '本轮新问题',
    attachments: [],
    provider
  });
  return out.map((m) =>
    typeof m.content === 'string'
      ? m.content
      : ((m.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')?.text ?? '')
  );
}

describe('失败记录不进模型上下文', () => {
  beforeEach(() => {
    ctx.rows = [];
    ctx.queries = [];
  });

  it('status=ERROR 的历史行不会被当成上一轮回答发给模型', async () => {
    await seed();

    const out = await build();

    expect(out.join('\n')).not.toContain(ERROR_TEXT);
  });

  it('status=PARTIAL 的真实内容仍然保留', async () => {
    await seed();

    const out = await build();

    expect(out.join('\n')).toContain(PARTIAL_TEXT);
  });

  it('ERROR 行不占窗口名额：捞的时候就在库里排除', async () => {
    await seed();

    await build();

    expect(ctx.queries[0].where?.status?.not).toBe('ERROR');
  });
});
