import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 按 id 批量取会话标题，给记忆面板显示「来自哪次对话」用。
 *
 * 三件事必须钉住：
 * 一、查询永远带上 userId——记忆行里的 chatId 是系统写的，但界面拿到的是任意字符串，
 *    不带归属就是拿别人的会话 id 也能换到标题；
 * 二、标题是密文，返回前必须解密成明文，且解不开时不能把密文原样吐给浏览器；
 * 三、这是设置页的读路径，不是每轮 AI 对话的读路径，所以空列表要直接不发查询。
 */
type ChatRow = { id: string; userId: string; titleCiphertext: string };

const db = vi.hoisted(() => ({
  rows: [] as ChatRow[],
  reads: [] as unknown[]
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: {
      findMany: (args: { where?: Record<string, unknown> }) => {
        db.reads.push(args);
        const where = args.where ?? {};
        const ids = (where.id as { in?: string[] } | undefined)?.in ?? [];
        return Promise.resolve(
          db.rows.filter((row) => row.userId === where.userId && ids.includes(row.id))
        );
      }
    }
  }
}));

async function chats() {
  return await import('@/lib/chats');
}
async function crypto() {
  return await import('@/lib/crypto');
}

const USER = 'user-a';

beforeEach(() => {
  db.rows = [];
  db.reads = [];
});

describe('按 id 取会话标题', () => {
  it('只返回这个用户名下的会话：别人的同名 id 换不到标题', async () => {
    const { encryptString } = await crypto();
    db.rows = [
      { id: 'chat-1', userId: USER, titleCiphertext: encryptString('我的对话', `chat-title:chat-1`) },
      { id: 'chat-2', userId: 'user-b', titleCiphertext: encryptString('别人的对话', `chat-title:chat-2`) }
    ];

    const { listChatTitles } = await chats();
    const titles = await listChatTitles(USER, ['chat-1', 'chat-2']);

    expect(Object.keys(titles)).toEqual(['chat-1']);
    expect(titles['chat-1']).toBe('我的对话');
  });

  it('标题从密文解出来才返回，库里存的原文一个字都不外泄', async () => {
    const { encryptString } = await crypto();
    db.rows = [{ id: 'chat-1', userId: USER, titleCiphertext: encryptString('周末计划', `chat-title:chat-1`) }];

    const { listChatTitles } = await chats();
    const titles = await listChatTitles(USER, ['chat-1']);

    expect(titles['chat-1']).toBe('周末计划');
  });

  it('AAD 绑的是会话 id，绑错人的标题解不开也只能给占位文案', async () => {
    const { encryptString } = await crypto();
    db.rows = [
      { id: 'chat-1', userId: USER, titleCiphertext: encryptString('串了', `chat-title:chat-9`) }
    ];

    const { listChatTitles } = await chats();
    const titles = await listChatTitles(USER, ['chat-1']);

    expect(titles['chat-1']).toBe('无法解密的会话');
  });

  it('传空列表时一条查询都不发', async () => {
    const { listChatTitles } = await chats();

    expect(await listChatTitles(USER, [])).toEqual({});
    expect(db.reads).toEqual([]);
  });

  it('id 去重后一次查完：同一个对话记了多条记忆，标题只解一次', async () => {
    const { encryptString } = await crypto();
    db.rows = [{ id: 'chat-1', userId: USER, titleCiphertext: encryptString('反复提到', `chat-title:chat-1`) }];

    const { listChatTitles } = await chats();
    const titles = await listChatTitles(USER, ['chat-1', 'chat-1', 'chat-1']);

    expect(db.reads).toHaveLength(1);
    expect((db.reads[0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(['chat-1']);
    expect(titles).toEqual({ 'chat-1': '反复提到' });
  });

  it('对话已经删掉了就不出现在映射里，交给界面去显示「原对话已删除」', async () => {
    const { listChatTitles } = await chats();

    expect(await listChatTitles(USER, ['chat-gone'])).toEqual({});
  });

  it('只取 id 和标题两列，不把消息和正文一起捞出来', async () => {
    const { listChatTitles } = await chats();

    await listChatTitles(USER, ['chat-1']);

    expect((db.reads[0] as { select: Record<string, unknown> }).select).toEqual({
      id: true,
      titleCiphertext: true
    });
  });
});
