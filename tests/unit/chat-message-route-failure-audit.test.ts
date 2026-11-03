import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 本轮对话失败时的两件收尾工作（原来都不做）：
 * ④ 没有拿到任何内容也要落一条 status=ERROR 的助手消息——刷新后历史里仍然看得见"出错了"，
 *    而不是只剩用户那句孤零零的提问；
 * ① 只要真的发起了这一轮就写审计，原先 `doneSent` 只在模型自己说 done 时才为真，
 *    于是失败、取消、以及模型没发 done 的轮次在审计里完全不存在。
 *
 * 只 mock 四个外围模块（prisma / auth / providers / ai），chats.ts 与 audit.ts 走真实代码，
 * 所以 ERROR 行的列名、加密 AAD、审计的 status/error 都是真实路径上产出的。
 *
 * 后半段管另一件事：答完之后那句入队。cognitiveTask 这个 delegate 必须在这儿——
 * 缺了它，enqueueCognitiveTask 会把 `undefined.create` 的 TypeError 一起吞进自己的 catch，
 * 于是这几条测试能在「欠账永远写不进去」的状态下绿着。
 */
const ctx = vi.hoisted(() => ({
  behavior: 'success' as
    | 'success'
    | 'throw'
    | 'partial-throw'
    | 'no-done'
    | 'abort'
    | 'already-aborted',
  rows: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
  taskRows: [] as Array<Record<string, any>>,
  // 入队那一步按住的开关：松开之前 create 的 promise 不落地，
  // 于是「审计有没有排在它后面」就变成「路由到底 await 没 await」的证据。
  holdTask: false,
  releaseTask: null as null | (() => void),
  modelCalls: 0,
  abortRequest: null as null | (() => void),
  sawAbortedSignal: null as null | boolean
}));

const USER = { id: 'user-1', username: 'konxing' };
const CHAT_ID = 'chat-1';
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
};

vi.mock('@/lib/auth', () => ({
  requireUser: () => {
    // 'already-aborted' 用它把断连安排在路由挂 abort 监听之前——真实线上就是这一类竞态。
    if (ctx.behavior === 'already-aborted') ctx.abortRequest?.();
    return Promise.resolve({ user: USER, session: { id: 'sess-1' } });
  }
}));

vi.mock('@/lib/providers', () => ({
  capabilitiesOf: (provider: { capabilities: string[] }) => provider.capabilities,
  getProviderForUser: () => Promise.resolve(PROVIDER),
  resolveDefaultProvider: () => Promise.resolve(PROVIDER)
}));

vi.mock('@/lib/prisma', async () => {
  const { encryptString } = await import('@/lib/crypto');

  function chatRow() {
    return {
      id: CHAT_ID,
      userId: USER.id,
      titleCiphertext: encryptString('新对话', `chat-title:${CHAT_ID}`),
      modelProviderId: PROVIDER.id,
      modelId: PROVIDER.modelId,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z')
    };
  }

  const messageDelegate = {
    create: ({ data }: { data: Record<string, any> }) => {
      ctx.rows.push(data);
      return Promise.resolve({
        ...data,
        attachments: [],
        createdAt: new Date('2026-01-01T00:01:00.000Z')
      });
    },
    findMany: () => Promise.resolve([])
  };
  const chatDelegate = {
    findFirst: () => Promise.resolve(chatRow()),
    update: ({ data }: { data: Record<string, any> }) =>
      Promise.resolve({ ...chatRow(), ...data })
  };
  const tx = {
    message: messageDelegate,
    chat: chatDelegate,
    attachment: { updateMany: () => Promise.resolve({ count: 0 }) }
  };

  return {
    prisma: {
      message: messageDelegate,
      chat: chatDelegate,
      attachment: { findMany: () => Promise.resolve([]), updateMany: () => Promise.resolve({ count: 0 }) },
      auditLog: {
        create: ({ data }: { data: Record<string, any> }) => {
          ctx.audit.push(data);
          return Promise.resolve(data);
        }
      },
      // 欠账表。缺了这个 delegate，enqueueCognitiveTask 会把 `undefined.create` 的
      // TypeError 一起吞进自己的 catch 里——那三条失败路径测试就会在「入队永远失败」
      // 的状态下绿着，所以它必须在这儿。
      cognitiveTask: {
        create: ({ data }: { data: Record<string, any> }) => {
          ctx.taskRows.push(data);
          if (!ctx.holdTask) return Promise.resolve(data);
          return new Promise((resolve) => {
            ctx.releaseTask = () => resolve(data);
          });
        }
      },
      $transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)
    }
  };
});

vi.mock('@/lib/ai', async () => {
  const { ApiError } = await import('@/lib/http');

  async function* events(signal: AbortSignal) {
    if (ctx.behavior === 'throw') {
      throw new ApiError(502, 'AI_PROVIDER_ERROR', '模型服务暂时不可用');
    }
    if (ctx.behavior === 'partial-throw') {
      yield { type: 'delta', text: '写了一半' };
      throw new ApiError(502, 'AI_STREAM_ENDED', '模型输出中断');
    }
    if (ctx.behavior === 'no-done') {
      yield { type: 'delta', text: '没有 done 事件' };
      return;
    }
    if (ctx.behavior === 'abort') {
      // 由测试在这一刻把客户端连接掐断，路由的 abort 监听器此时必定已经挂上；
      // 等一个宏任务让 onAbort 落地，再模拟 fetch 在取消时抛 AbortError。
      ctx.abortRequest?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      ctx.sawAbortedSignal = signal.aborted;
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }
    if (ctx.behavior === 'already-aborted') {
      // 客户端在路由挂监听之前就已经断开：内部 signal 必须已经被带上，否则这次
      // 模型调用会冲着一条已经不存在的连接跑完整轮。
      ctx.sawAbortedSignal = signal.aborted;
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }
    yield { type: 'delta', text: '正常回答' };
    yield { type: 'usage', inputTokens: 11, outputTokens: 7 };
    yield { type: 'done' };
  }

  return {
    streamChatCompletion: (input: { signal: AbortSignal }) => {
      ctx.modelCalls += 1;
      return events(input.signal);
    },
    transcribeAudio: () => Promise.resolve({ text: '' })
  };
});

async function post(signal?: AbortSignal) {
  const { POST } = await import('@/app/api/chats/[id]/messages/route');
  const request = new Request(`http://127.0.0.1:3000/api/chats/${CHAT_ID}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3000',
      'x-client-ip': '203.0.113.21',
      'user-agent': 'vitest'
    },
    body: JSON.stringify({ content: '今天天气如何', attachmentIds: [] }),
    ...(signal ? { signal } : {})
  });
  const response = await POST(request, { params: Promise.resolve({ id: CHAT_ID }) });
  // writeAudit 是挂在 finally 里的游离 promise，给一个宏任务让它落地。
  const text = await response.text();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { response, text };
}

function assistantRows() {
  return ctx.rows.filter((row) => row.role === 'ASSISTANT');
}

describe('本轮失败时的落库与审计', () => {
  beforeEach(() => {
    ctx.behavior = 'success';
    ctx.rows = [];
    ctx.audit = [];
    ctx.taskRows = [];
    ctx.holdTask = false;
    ctx.releaseTask = null;
    ctx.modelCalls = 0;
    ctx.abortRequest = null;
    ctx.sawAbortedSignal = null;
  });

  it('模型一开口就报错：仍然落一条 ERROR 助手消息，内容是给用户看的失败文案', async () => {
    ctx.behavior = 'throw';
    const { decryptMessage } = await import('@/lib/chats');

    const { text } = await post();
    const rows = assistantRows();

    expect(text).toContain('"type":"error"');
    expect(text).toContain('AI_PROVIDER_ERROR');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ERROR');
    expect(rows[0].errorCode).toBe('AI_PROVIDER_ERROR');
    expect(decryptMessage(rows[0] as never)).toBe('模型服务暂时不可用');
    // 失败轮次不该同时冒充一次成功的 COMPLETE。
    expect(rows.filter((row) => row.status === 'COMPLETE')).toHaveLength(0);
  });

  it('写了一半才断：保留 PARTIAL 行，不额外补 ERROR 行', async () => {
    ctx.behavior = 'partial-throw';

    const { text } = await post();
    const rows = assistantRows();

    expect(text).toContain('"type":"partial"');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PARTIAL');
    expect(rows[0].errorCode).toBe('AI_STREAM_ENDED');
  });

  it('失败轮次也进审计：status=FAILURE 并带上错误码', async () => {
    ctx.behavior = 'throw';

    await post();

    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({
      action: 'chat.message',
      targetType: 'chat',
      targetId: CHAT_ID,
      actorId: USER.id,
      status: 'FAILURE',
      error: 'AI_PROVIDER_ERROR'
    });
    expect((ctx.audit[0].after as Record<string, unknown>).providerId).toBe(PROVIDER.id);
  });

  it('用户取消：不写助手消息，但审计记下这一轮被取消', async () => {
    ctx.behavior = 'abort';
    const controller = new AbortController();
    ctx.abortRequest = () => controller.abort();

    await post(controller.signal);

    expect(ctx.sawAbortedSignal).toBe(true);
    expect(assistantRows()).toHaveLength(0);
    expect(ctx.rows.filter((row) => row.role === 'USER')).toHaveLength(1);
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({ action: 'chat.message', status: 'FAILURE', error: 'ABORTED' });
  });

  it('连接在路由挂监听之前就断了：内部 signal 也必须已经中止', async () => {
    ctx.behavior = 'already-aborted';
    const controller = new AbortController();
    ctx.abortRequest = () => controller.abort();

    await post(controller.signal);

    expect(ctx.sawAbortedSignal).toBe(true);
    expect(assistantRows()).toHaveLength(0);
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({ status: 'FAILURE', error: 'ABORTED' });
  });

  it('成功轮次照旧一条 COMPLETE + 一条 SUCCESS 审计', async () => {
    ctx.behavior = 'success';

    const { text } = await post();
    const rows = assistantRows();

    expect(text).toContain('"type":"done"');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMPLETE');
    expect(rows[0].outputTokens).toBe(7);
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({ action: 'chat.message', status: 'SUCCESS', error: null });
    expect((ctx.audit[0].after as Record<string, unknown>).chars).toBe('正常回答'.length);
  });

  it('模型没发 done 事件也算这一轮发生过：审计不能凭 done 事件存在与否', async () => {
    ctx.behavior = 'no-done';

    const { text } = await post();
    const rows = assistantRows();

    expect(text).toContain('"type":"done"');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMPLETE');
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].status).toBe('SUCCESS');
    // 上下文里没有 ERROR 行，窗口过滤条件同样带上了这轮的用户消息。
    expect(ctx.modelCalls).toBe(1);
  });

  it('成功轮次欠下一条待办，而且路由真的等到它落库才写审计', async () => {
    ctx.behavior = 'success';
    ctx.holdTask = true;

    const { text } = await post();

    expect(text).toContain('"type":"done"');
    expect(ctx.taskRows).toHaveLength(1);
    expect(ctx.taskRows[0]).toMatchObject({ userId: USER.id, chatId: CHAT_ID, kind: 'MEMORY' });
    // 入队还没落地，收尾的审计就必须还排在其后：这一条证明路由 await 了它，不是又 void 掉。
    expect(ctx.audit).toHaveLength(0);

    ctx.releaseTask!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.audit).toHaveLength(1);
  });

  it('欠账行里只有 id：用户那句话不在这张表上（任务书 5.5）', async () => {
    ctx.behavior = 'success';

    await post();

    expect(ctx.taskRows).toHaveLength(1);
    expect(Object.keys(ctx.taskRows[0]).sort()).toEqual(['chatId', 'kind', 'sourceMessageId', 'userId']);
    // 欠的是「哪句话」，不是那句话本身：正文靠这个 id 从消息行解密重建。
    expect(ctx.taskRows[0].sourceMessageId).toBe(ctx.rows.find((row) => row.role === 'USER')?.id);
    expect(JSON.stringify(ctx.taskRows)).not.toContain('今天天气如何');
  });

  it('失败的轮次不欠账：只有答完的那一轮才记', async () => {
    ctx.behavior = 'throw';

    await post();

    expect(ctx.taskRows).toHaveLength(0);
  });
});
