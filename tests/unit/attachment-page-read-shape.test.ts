import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 打开会话、向更早翻页、附件库这三条页面读取，今天都要把整页文档正文的密文搬回进程。
 *
 * 实测（临时表复刻同一条查询，100 个附件一页）：每份正文 20 KB 时 24.0 ms → 不带这列 1.2 ms；
 * 200 KB 时 83.2 ms → 1.7 ms；2 MB（正文硬截 2,000,000 字符换来的上限）时 807.4 ms → 1.1 ms。
 * 上限叠得上去：一页 60 条消息（`src/lib/chats.ts:167`）× 每条 15 个附件，附件库页 take 500。
 *
 * 而这一列在页面上只喂给一个布尔 `hasText`，那个布尔没有任何页面消费者（唯一的真消费者
 * 是上传回执，见 tests/unit/upload-document-size-gate.test.ts）。所以这片钉两件事：
 * ① 三条读取的请求列里不得出现两个大列；② 收口后 UI 真正在用的字段一个都不能少。
 */
const ctx = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: Record<string, unknown> }>,
  chat: null as Record<string, unknown> | null,
  messages: null as Array<Record<string, unknown>> | null,
  attachments: null as Array<Record<string, unknown>> | null,
  cursorCreatedAt: null as Date | null
}));

/** 只投影 `select` 里点名列，和 Prisma 一致：这样「没点这列」才会真的反映到返回值上。 */
function project(row: Record<string, unknown>, select: unknown): Record<string, unknown> {
  if (!select) return { ...row };
  const keys = Object.entries(select as Record<string, boolean>)
    .filter(([, on]) => on)
    .map(([key]) => key);
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function withAttachments(message: Record<string, unknown>, select: unknown): Record<string, unknown> {
  const { attachments, ...rest } = message;
  return { ...rest, attachments: (attachments as Array<Record<string, unknown>>).map((a) => project(a, select)) };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: {
      findFirst: (args: Record<string, unknown>) => {
        ctx.calls.push({ op: 'chat.findFirst', args });
        const include = args?.include as Record<string, unknown> | undefined;
        const chat = { ...ctx.chat! };
        const messages = include?.messages as Record<string, unknown> | undefined;
        if (messages) {
          const attSelect = (messages.include as Record<string, unknown>).attachments;
          chat.messages = ctx.messages!.map((m) =>
            withAttachments(m, (attSelect as Record<string, unknown>).select)
          );
        }
        return Promise.resolve(chat);
      }
    },
    message: {
      findFirst: (args: Record<string, unknown>) => {
        ctx.calls.push({ op: 'message.findFirst', args });
        return Promise.resolve({ createdAt: ctx.cursorCreatedAt });
      },
      findMany: (args: Record<string, unknown>) => {
        ctx.calls.push({ op: 'message.findMany', args });
        const include = args?.include as Record<string, unknown> | undefined;
        const attSelect = (include?.attachments as Record<string, unknown>)?.select;
        return Promise.resolve(ctx.messages!.map((m) => withAttachments(m, attSelect)));
      }
    },
    attachment: {
      findMany: (args: Record<string, unknown>) => {
        ctx.calls.push({ op: 'attachment.findMany', args });
        return Promise.resolve(ctx.attachments!.map((a) => project(a, args.select)));
      }
    }
  }
}));

vi.mock('unpdf', () => ({ extractText: vi.fn() }));
vi.mock('mammoth', () => ({ default: { extractRawText: vi.fn() } }));

const MB = 1024 * 1024;

/** 三条读取各自点名的附件列，收集到同一个数组里断言。 */
function attachmentSelects(): Array<Record<string, boolean>> {
  return ctx.calls.flatMap((call) => {
    const args = call.args as Record<string, any>;
    if (call.op === 'attachment.findMany') return [args.select as Record<string, boolean>];
    const page = args.include?.messages?.include?.attachments ?? args.include?.attachments;
    return page?.select ? [page.select as Record<string, boolean>] : [];
  });
}

async function readAllThreePages() {
  const { getChatDetail, getOlderMessages, listAttachmentLibrary } = await import('@/lib/chats');
  await getChatDetail('chat-1', 'user-1');
  await getOlderMessages('chat-1', 'user-1', 'msg-1');
  await listAttachmentLibrary('user-1');
}

beforeEach(async () => {
  const { encryptString } = await import('@/lib/crypto');
  const { encryptMessage } = await import('@/lib/chats');
  ctx.calls = [];
  ctx.chat = {
    id: 'chat-1',
    userId: 'user-1',
    titleCiphertext: encryptString('周末计划', 'chat-title:chat-1'),
    modelProviderId: null,
    modelId: null,
    provider: { name: '默认模型' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z')
  };
  const attachmentRow = (id: string, kind: string, mime: string, size: number, text: string | null) => ({
    id,
    userId: 'user-1',
    chatId: 'chat-1',
    messageId: 'msg-1',
    kind,
    mime,
    size,
    sha256: 'b'.repeat(64),
    storageKey: `user-1/${id}.enc`,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    originalNameCiphertext: encryptString(`${id}.${mime === 'image/png' ? 'png' : 'pdf'}`, `attachment-name:${id}`),
    extractedTextCiphertext: text,
    chunksCiphertext: text ? 'CHUNKS' : null
  });
  ctx.attachments = [
    attachmentRow('att-big', 'FILE', 'application/pdf', 51 * MB, null),
    attachmentRow('att-doc', 'FILE', 'application/pdf', 1 * MB, 'CIPHERTEXT-BODY'),
    attachmentRow('att-img', 'IMAGE', 'image/png', 200 * 1024, null)
  ];
  ctx.messages = [
    {
      id: 'msg-1',
      chatId: 'chat-1',
      role: 'USER',
      contentCiphertext: encryptMessage('看下这份论文', 'msg-1'),
      modelId: null,
      status: 'OK',
      inputTokens: null,
      outputTokens: null,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      attachments: ctx.attachments
    }
  ];
  ctx.cursorCreatedAt = new Date('2026-01-02T00:00:00.000Z');
});

describe('附件页面读取的请求列', () => {
  it('三条页面读取都不再点名两个大列', async () => {
    await readAllThreePages();

    const selects = attachmentSelects();
    // 防空转：三条读取都得真的发生、各自都真的点名了列，否则下面的「没有大列」是空话。
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      expect(select.originalNameCiphertext).toBe(true);
      expect(select).not.toHaveProperty('extractedTextCiphertext');
      expect(select).not.toHaveProperty('chunksCiphertext');
    }
  });

  it('收口后 UI 在用的字段一个不少，且不再有无人消费的 hasText', async () => {
    const { getChatDetail } = await import('@/lib/chats');
    const detail = await getChatDetail('chat-1', 'user-1');
    const [big, doc, image] = detail.messages[0]!.attachments;

    expect(image).toMatchObject({ kind: 'IMAGE', size: 200 * 1024 });
    expect(big).toMatchObject({ name: 'att-big.pdf', kind: 'FILE', size: 51 * MB });
    // 正文列不搬回来了，这两条只能靠 mime/size 成立——这正是本片的等价性主张。
    expect(big!.textSkipped).toBe(true);
    expect(doc!.textSkipped).toBe(false);
    expect(image!.textSkipped).toBe(false);
    for (const attachment of [big, doc, image]) {
      expect(attachment).not.toHaveProperty('hasText');
    }
  });
});
