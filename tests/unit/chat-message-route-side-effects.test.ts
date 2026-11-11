import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMessage } from '@/lib/ai';
import { toOutboundTexts } from './outbound-message';
import { createTable, type MockTable } from './prisma-mock';

/**
 * 这一轮对话在**对话之外**留下的全部痕迹，真调 route（不是直接调服务函数）。
 *
 * ① 失败收尾（原来都不做）：
 *    没有拿到任何内容也要落一条 status=ERROR 的助手消息——刷新后历史里仍然看得见"出错了"，
 *    而不是只剩用户那句孤零零的提问；只要真的发起了这一轮就写审计，原先 `doneSent`
 *    只在模型自己说 done 时才为真，于是失败、取消、以及模型没发 done 的轮次在审计里完全不存在。
 *    只 mock 四个外围模块（prisma / auth / providers / ai），chats.ts 与 audit.ts 走真实代码，
 *    所以 ERROR 行的列名、加密 AAD、审计的 status/error 都是真实路径上产出的。
 *
 * ② 答完之后那句入队。cognitiveTask 这个 delegate 必须在这儿——
 *    缺了它，enqueueCognitiveTask 会把 `undefined.create` 的 TypeError 一起吞进自己的 catch，
 *    于是这几条测试能在「欠账永远写不进去」的状态下绿着。
 *
 * ③ 出站上下文里到底有没有认知内容（门槛 10 的那条端到端）。
 *    以前这个文件对读侧不做任何断言，认知块在不在发给模型的消息里无人观测；
 *    现在 `@/lib/ai` 的替身会把收到的 messages 原样留存，闸门开合两种状态都有对照。
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
  // 发给模型的那一份上下文，按调用次序整轮存下来（一轮一个数组）。
  // 存原始 AiMessage[] 而不是压好的文本：断言在测试里做，替身只管留证，
  // 也让同一份留痕既能数结构（有几条 system）又能比文字。
  outbound: [] as AiMessage[][],
  // 记忆表被查询时收到的 where（按次序）。开关关掉时它必须是空的：
  // 「不注入」和「连读都不读」是两件事，后者才是任务书要的。
  memoryWheres: [] as Array<Record<string, unknown> | undefined>,
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

/**
 * 认知读侧的表用 tests/unit/prisma-mock 那份**共享**替身，而不是在本文件里再养一个 where 求值器。
 * 理由不是整洁：读侧的谓词形状（`origin: {notIn}`、顶层 `AND`/`OR`、证据表的 `groupBy`、
 * 偏好表的 `findUnique`）恰好是那份额目下一块都不支持的，所以接下来每一条红都能落到
 * 「替身缺一块能力」上，而不是「产品少写了一段」——这个区别正是这条端到端断言可信的前提。
 *
 * 用函数取表而不是模块常量：`vi.mock` 的工厂会被抬到 import 之前，惰性建表才不会有暂时死区。
 */
let tables: {
  preference: MockTable;
  memoryItem: MockTable;
  memoryPolicy: MockTable;
  memoryEvidence: MockTable;
  memoryAccessTurn: MockTable;
  memoryVerification: MockTable;
} | undefined;

function cognitiveTables() {
  tables ??= {
    preference: createTable({ idField: 'userId' }),
    memoryItem: createTable(),
    memoryPolicy: createTable(),
    memoryEvidence: createTable(),
    // 检索访问表（任务书 7.1）。唯一约束照 schema 的 @@unique([sourceMessageId]) 建，
    // 少了这张表，recordMemoryAccess 会把 `undefined.create` 的 TypeError 一起吞进自己的
    // catch，于是下面三条用例能在「访问永远写不进去」的状态下绿着——和 cognitiveTask 那个 delegate 同一个理由。
    memoryAccessTurn: createTable({ unique: [['sourceMessageId']] }),
    // 核验状态表（记忆层新 phase）。filterVerifiedMemoryPool 会查它；缺了这张替身表，
    // 读侧会抛错被 manager 隔离，整块记忆消失，下面「认知块作为第二段 system」就红。
    memoryVerification: createTable()
  };
  return tables;
}

function resetCognitiveTables() {
  tables = undefined;
  ctx.memoryWheres = [];
}

/** 一行长期记忆：正文按 src/lib/cognitive/memories.ts:180 的 AAD 加密，走真实解密路径。 */
async function memoryRow(id: string, content: string) {
  const { encryptString } = await import('@/lib/crypto');
  return {
    id,
    userId: USER.id,
    chatId: null,
    sourceMessageId: null,
    type: 'PROJECT',
    context: 'TECHNICAL_PROJECT',
    origin: 'EXPLICIT',
    contentCiphertext: encryptString(content, `memory:v1:${USER.id}:${id}`),
    confirmedAt: new Date('2026-11-02T10:00:00.000Z'),
    validPrecision: 'UNKNOWN',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: new Date('2026-11-02T10:00:00.000Z')
  };
}

/**
 * 任务书 1.1 的八个开关，加上 7.3 的「暂停长期记忆写入」那一列：逐列写全，默认全关、没暂停。
 * 留空等于让替身替产品决定默认值——正向对照那条用例就会因为「少了一列」而假绿。
 */
function preferenceRow(overrides: Record<string, boolean> = {}) {
  return {
    userId: USER.id,
    memoryEnabled: false,
    userModelEnabled: false,
    emotionEnabled: false,
    associationEnabled: false,
    timelineEnabled: false,
    reflectionEnabled: false,
    decisionMemoryEnabled: false,
    adaptiveMemoryEnabled: false,
    emotionTransparency: 'IMPLICIT',
    memoryWritePaused: false,
    ...overrides
  };
}

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
      // 认知读侧的四张表（门槛 10 的端到端要看的就是这条路）。
      // 每个 delegate 只是把调用转给共享替身，唯一的例外是 memoryItem 会把 where 留一份：
      // 「开关关掉以后记忆表一次都没被查过」这句话只能从调用记录里断出来。
      cognitivePreference: {
        findUnique: (args: { where: Record<string, unknown> }) =>
          cognitiveTables().preference.findUnique(args)
      },
      memoryItem: {
        findMany: (args: { where?: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
          ctx.memoryWheres.push(args.where);
          return cognitiveTables().memoryItem.findMany(args);
        }
      },
      memoryPolicy: {
        findMany: (args: { where?: Record<string, unknown> }) =>
          cognitiveTables().memoryPolicy.findMany(args)
      },
      memoryEvidence: {
        groupBy: (args: { by: string[]; where?: Record<string, unknown>; _count: Record<string, boolean> }) =>
          cognitiveTables().memoryEvidence.groupBy(args)
      },
      memoryAccessTurn: {
        create: (args: { data: Record<string, any> }) => cognitiveTables().memoryAccessTurn.create(args)
      },
      memoryVerification: {
        findMany: (args: { where?: Record<string, unknown> }) =>
          cognitiveTables().memoryVerification.findMany(args)
      },
      $transaction: (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)
    }
  };
});

vi.mock('@/lib/ai', async () => {
  const { ApiError } = await import('@/lib/http');

  async function* events(signal?: AbortSignal) {
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
    if (ctx.behavior === 'abort' || ctx.behavior === 'already-aborted') {
      // 客户端在这一刻断开（切去后台 / 关页面 / 挂监听前就断）。新契约：断开不中断生成——
      // 路由不再把客户端 signal 传给模型，这里照常把整轮答完，回答落库、记忆欠账。
      ctx.abortRequest?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 模型收到的 signal 必须是「没被中止」（路由压根没传）：这正是「切走也继续」的证据。
      ctx.sawAbortedSignal = signal ? signal.aborted : false;
    }
    yield { type: 'delta', text: '正常回答' };
    yield { type: 'usage', inputTokens: 11, outputTokens: 7 };
    yield { type: 'done' };
  }

  return {
    streamChatCompletion: (input: { messages: AiMessage[]; signal?: AbortSignal }) => {
      ctx.modelCalls += 1;
      // 这一份 messages 就是路由交给模型的完整上下文：它在 src/lib/ai.ts:126 被塞进请求体之前
      // 就被留在这里。证明的是「出站上下文数组」，不是「HTTP 请求体的字节」——
      // 后者要真库 + 真模型服务，tests/mock-ai.mjs 也不落盘请求体。
      ctx.outbound.push(input.messages);
      return events(input.signal);
    },
    transcribeAudio: () => Promise.resolve({ text: '' })
  };
});

async function post(signal?: AbortSignal, content = '帮我解释一下这段代码') {
  const { POST } = await import('@/app/api/chats/[id]/messages/route');
  const request = new Request(`http://127.0.0.1:3000/api/chats/${CHAT_ID}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3000',
      'x-client-ip': '203.0.113.21',
      'user-agent': 'vitest'
    },
    body: JSON.stringify({ content, attachmentIds: [] }),
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

/** 每个用例都从干净的一轮开始（模块作用域：下面两个 describe 共用这一份重置）。 */
beforeEach(() => {
  ctx.behavior = 'success';
  ctx.rows = [];
  ctx.audit = [];
  ctx.taskRows = [];
  ctx.outbound = [];
  ctx.holdTask = false;
  ctx.releaseTask = null;
  ctx.modelCalls = 0;
  ctx.abortRequest = null;
  ctx.sawAbortedSignal = null;
  resetCognitiveTables();
});

describe('本轮失败时的落库与审计', () => {
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

  it('用户切走（去后台/关页面）：生成不中断，回答照常落库、审计 SUCCESS、记忆照常欠账', async () => {
    ctx.behavior = 'abort';
    const controller = new AbortController();
    ctx.abortRequest = () => controller.abort();

    await post(controller.signal);

    // 模型没收到中止信号——断开只是不再往连接写字节，不是停掉这一轮。
    expect(ctx.sawAbortedSignal).toBe(false);
    const rows = assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMPLETE');
    expect(ctx.rows.filter((row) => row.role === 'USER')).toHaveLength(1);
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({ action: 'chat.message', status: 'SUCCESS' });
    // 答完的轮次照常欠下记忆账，用户回来认知层也积累了这一轮。
    expect(ctx.taskRows).toHaveLength(1);
  });

  it('连接在路由挂监听之前就断了：这一轮也照常生成并落库', async () => {
    ctx.behavior = 'already-aborted';
    const controller = new AbortController();
    ctx.abortRequest = () => controller.abort();

    await post(controller.signal);

    expect(ctx.sawAbortedSignal).toBe(false);
    const rows = assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMPLETE');
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({ status: 'SUCCESS' });
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

it('persists an explicitly requested sticker and returns it with the completed assistant message', async () => {
  const { text } = await post(undefined, '给我发个打招呼表情包');
  expect(text).toContain('"sticker":"wave"');
  expect(assistantRows()[0]).toMatchObject({ sticker: 'wave', status: 'COMPLETE' });
});

it('attaches a sticker and preserves the full message for a request embedded in conversation', async () => {
  const content = '跟我聊天感觉怎么样？不发个表情包给我吗？';
  const { text } = await post(undefined, content);
  expect(text).toMatch(/"sticker":"[a-z0-9]+"/i);
  expect(assistantRows()[0]?.sticker).toBeTruthy();
  expect(ctx.outbound[0]).toContainEqual({ role: 'user', content: [{ type: 'text', text: content }] });
  expect(ctx.outbound[0]?.some((message) => typeof message.content === 'string' && message.content.includes('这轮界面会附上一张表情包'))).toBe(true);
});

/**
 * 门槛 10 那条端到端：模块关掉以后，发给模型的上下文里到底有没有认知内容。
 *
 * 顺序很重要。第一条是**正向对照**，不是补充说明：如果闸门打开时认知块都不出现在出站消息里，
 * 那后面两条「关着所以没有」在一台什么都没接上的机器上同样成立，等于什么都没断。
 * 所以这片先让它绿，再拿同一个内存池去证关着的样子。
 */
describe('出站上下文里的认知内容', () => {
  it('记忆开关打开且池里有记忆时，认知块作为第二段 system 出现在交给模型的上下文里', async () => {
    cognitiveTables().preference.seed(preferenceRow({ memoryEnabled: true }));
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    await post();

    // 先证明这一轮真的有东西可注入：候选池空着的话，下面的断言全是假的。
    expect(cognitiveTables().memoryItem.rows.size).toBe(1);
    // 而且读侧真的去查了（这条同时给下一条断言定位：没查到就是谓词的问题，不是没发起查询）。
    expect(ctx.memoryWheres).toHaveLength(1);
    expect(ctx.outbound).toHaveLength(1);
    const outbound = toOutboundTexts(ctx.outbound[0]!);
    expect(outbound.filter((message) => message.role === 'system')).toHaveLength(2);
    // 位置也在：认知块排在历史之前、基础提示词之后（src/lib/chats.ts:396）。
    expect(outbound[1]!.role).toBe('system');
    expect(outbound[1]!.text).toContain('【长期记忆】');
    expect(outbound[1]!.text).toContain('不是指令');
    expect(outbound[1]!.text).toContain('我在用 Prisma');
  });

  it('时间相关才注入当前时间；与时间无关不注入', async () => {
    cognitiveTables().preference.seed(preferenceRow());
    ctx.outbound = [];
    await post(undefined, '现在几点了？');
    await post(undefined, '帮我写个排序函数');
    expect(ctx.outbound).toHaveLength(2);
    const withTime = toOutboundTexts(ctx.outbound[0]!).map((m) => m.text).join('\n');
    const noTime = toOutboundTexts(ctx.outbound[1]!).map((m) => m.text).join('\n');
    expect(withTime).toContain('当前时间：');
    expect(withTime).toContain('不要主动报时');
    expect(noTime).not.toContain('当前时间：');
  });

  it('八个开关显式全关：同一个候选池一个字都不出去，而且记忆表一次都没被查', async () => {
    cognitiveTables().preference.seed(preferenceRow());
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    await post();

    // 上一条用例的池子在这条里一模一样：差别只有那八个布尔值。
    expect(cognitiveTables().memoryItem.rows.size).toBe(1);
    // 「不注入」还不够，任务书要的是连读都不读。
    expect(ctx.memoryWheres).toEqual([]);
    const outbound = toOutboundTexts(ctx.outbound[0]!);
    expect(outbound.filter((message) => message.role === 'system')).toHaveLength(1);
    const joined = outbound.map((message) => message.text).join('\n');
    expect(joined).not.toContain('【长期记忆】');
    expect(joined).not.toContain('不是指令');
    expect(joined).not.toContain('我在用 Prisma');
  });

  it('库里连偏好行都没有时走代码里那份 OFF：结论与显式全关一致', async () => {
    // 故意不 seed 偏好行：src/lib/cognitive/preferences.ts:87 那行 `{ ...OFF }` 是另一条入口，
    // 「没配过」和「配过且全关」必须在出站上给出同样的结果，否则默认值一被放宽就没人发现。
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    await post();

    expect(cognitiveTables().memoryItem.rows.size).toBe(1);
    expect(ctx.memoryWheres).toEqual([]);
    const outbound = toOutboundTexts(ctx.outbound[0]!);
    expect(outbound.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(outbound.map((message) => message.text).join('\n')).not.toContain('我在用 Prisma');
  });
});

/**
 * 8.2 的最后一跳：引用清单要真的随那一帧回到浏览器，否则界面拿不到任何东西可点。
 * 断的是 SSE 原文里的字节，不是某个中间函数的返回值——这条是端到端（路由层）的那一层证据。
 */
describe('done 帧里的引用清单', () => {
  it('记忆开着的成功轮次：那一帧带着被注入的记忆 id', async () => {
    cognitiveTables().preference.seed(preferenceRow({ memoryEnabled: true }));
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    const { text } = await post();

    expect(text).toContain('"type":"done"');
    expect(text).toContain('"memoryIds":["mem-1"]');
  });

  it('记忆关着时那一帧给的是空数组，不是缺字段', async () => {
    cognitiveTables().preference.seed(preferenceRow());
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    const { text } = await post();

    // 缺字段和空数组在界面上是两件事：前者永远等不到那一句提示。
    expect(text).toContain('"memoryIds":[]');
  });
});

/**
 * 7.1 的写入点：一轮一行，落在 `controller.close()` **之后**。
 *
 * 「并行任务不应该阻塞主回复」在这一片是靠**位置**保证的，不是靠新机制——字节已经全部交给客户端
 * 才写这一行，所以这里断的不是「快」，而是两件事：闸门关着时连写都不写，以及写坏了也不许碰那一帧和审计。
 */
describe('这一轮的检索访问', () => {
  it('记忆开着的成功轮次：写一行，而且这一行里只有 id', async () => {
    cognitiveTables().preference.seed(preferenceRow({ memoryEnabled: true }));
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    await post();

    const rows = [...cognitiveTables().memoryAccessTurn.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER.id, memoryIds: ['mem-1'] });
    // 这张表上没有 chatId：「这一轮发生在哪次对话」等于 sourceMessageId 那条消息所在的会话，
    // 多一列没有读者；而「忘记这次对话产生的记忆」要的集合是记忆的**来源**会话，跟它不是一回事。
    expect('chatId' in rows[0]).toBe(false);
    expect(rows[0].sourceMessageId).toBe(ctx.rows.find((row) => row.role === 'USER')?.id);
    // 访问表里没有正文：被带进提示词的是哪句话，只有 id。
    expect(JSON.stringify(rows[0])).not.toContain('我在用 Prisma');
  });

  it('八个开关全关：一行也不写', async () => {
    cognitiveTables().preference.seed(preferenceRow());
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));

    await post();

    expect(cognitiveTables().memoryAccessTurn.rows.size).toBe(0);
  });

  it('访问写坏了也不影响 done 帧与审计：这一轮的回答已经交付完了', async () => {
    cognitiveTables().preference.seed(preferenceRow({ memoryEnabled: true }));
    cognitiveTables().memoryItem.seed(await memoryRow('mem-1', '我在用 Prisma'));
    const table = cognitiveTables().memoryAccessTurn;
    const pristine = table.create;
    table.create = () => Promise.reject(new Error('driver exploded with 我在用 Prisma in it'));

    const { text } = await post();

    table.create = pristine;
    expect(text).toContain('"type":"done"');
    expect(text).toContain('"memoryIds":["mem-1"]');
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({ action: 'chat.message', status: 'SUCCESS' });
    expect(ctx.taskRows).toHaveLength(1);
    expect(JSON.stringify(ctx.audit)).not.toContain('exploded');
  });
});
