import { describe, expect, it } from 'vitest';
import { rankMemories, tokenize } from '@/lib/cognitive/retrieval';

/**
 * Phase 3 的第一块砖：关键词召回。
 *
 * 此前的读侧是按 recordedAt 倒序取前 8 条，和用户这一轮问什么完全无关——
 * 那不是检索，是「最近说过什么」。这一片把它换成按重合度排序，
 * 并且要求：查不出任何相关项时必须退回原来的时间顺序，不许比现状更差。
 *
 * 向量、图扩展、Reranker、RRF 都不在这里：前者要独立的 Embedding Provider 配置，
 * 后者要 MemoryRelation 表，都还不存在。
 */

interface Item {
  id: string;
  content: string;
  /** 测试里用它代替真实时间戳：越靠后表示越新。 */
  recordedAt: string;
}

/** 造一批记忆，index 越大越新（listMemories 返回的是倒序，所以这里再翻一次）。 */
function pool(entries: Array<[string, string]>): Item[] {
  return entries
    .map(([id, content], index) => ({
      id,
      content,
      recordedAt: new Date(Date.UTC(2026, 10, 1 + index)).toISOString()
    }))
    .reverse();
}

describe('tokenize', () => {
  it('中文按 bigram 切，英文和数字按整词切', () => {
    expect(tokenize('我住在杭州')).toEqual(['我住', '住在', '在杭', '杭州']);
    expect(tokenize('我在用 Prisma 6')).toEqual(['我在', '在用', 'prisma', '6']);
  });

  it('单个汉字也保留，否则短查询一个 token 都切不出来', () => {
    expect(tokenize('猫')).toEqual(['猫']);
  });

  it('大小写、空白和标点不构成另一个词', () => {
    expect(tokenize('  Next.js   15! ')).toEqual(tokenize('next js 15'));
  });

  it('没有可切的内容时返回空数组', () => {
    expect(tokenize('。。。')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('rankMemories', () => {
  const memories = pool([
    ['m1', '我在用 Prisma 做澄境的数据库层'],
    ['m2', '我住在杭州'],
    ['m3', '我打算明年考研'],
    ['m4', '我喜欢喝温水'],
    ['m5', '我在学 Rust'],
    ['m6', '我的项目用 Next.js 15'],
    ['m7', '我周末常去西湖跑步'],
    ['m8', '我在用 Tailwind 写样式'],
    ['m9', '我养了一只猫'],
    ['m10', '我决定把数据库换成 PostgreSQL']
  ]);

  it('按与这一轮提问的重合度排序，相关的排到最前面', () => {
    const ranked = rankMemories('我住在哪个城市来着，杭州是吗', memories, { limit: 3 });

    expect(ranked[0]?.id).toBe('m2');
  });

  it('英文关键词同样能召回', () => {
    const ranked = rankMemories('Prisma 还在用吗', memories, { limit: 3 });

    expect(ranked.map((item) => item.id)).toContain('m1');
  });

  it('池子里到处都有的词权重低，罕见的词才决定排序', () => {
    // 「我在」几乎每条都有，只有 m5 / m8 带「在学」「在用」这种区别性词。
    const ranked = rankMemories('我在学什么语言', memories, { limit: 2 });

    expect(ranked[0]?.id).toBe('m5');
  });

  it('limit 截断排序结果，不放大注入条数', () => {
    expect(rankMemories('我住在杭州', memories, { limit: 4 })).toHaveLength(4);
  });

  it('一个问题都对不上时，退回原来的时间倒序——不许比现状更差', () => {
    const ranked = rankMemories('zzz qqq', memories, { limit: 3 });

    expect(ranked.map((item) => item.id)).toEqual(memories.slice(0, 3).map((item) => item.id));
  });

  it('提问里没有可切的词时同样退回时间倒序', () => {
    const ranked = rankMemories('。。。', memories, { limit: 3 });

    expect(ranked.map((item) => item.id)).toEqual(memories.slice(0, 3).map((item) => item.id));
  });

  it('分数相同的按时间倒序，新的在前', () => {
    const tied = pool([
      ['a', '项目用 PostgreSQL'],
      ['b', '项目用 PostgreSQL'],
      ['c', '完全无关的一句话']
    ]);

    const ranked = rankMemories('PostgreSQL', tied, { limit: 2 });

    expect(ranked.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('部分命中的排在完全没命中的前面，剩下的名额由最近的补上', () => {
    const ranked = rankMemories('我养的那只猫叫什么来着', memories, { limit: 4 });

    expect(ranked[0]?.id).toBe('m9');
    expect(ranked).toHaveLength(4);
  });

  it('空池子返回空数组，不报错', () => {
    expect(rankMemories('我住在杭州', [], { limit: 8 })).toEqual([]);
  });

  it('不修改传进来的数组', () => {
    const before = memories.map((item) => item.id);

    rankMemories('我住在杭州', memories, { limit: 3 });

    expect(memories.map((item) => item.id)).toEqual(before);
  });
});
