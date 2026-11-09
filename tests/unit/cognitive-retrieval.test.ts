import { describe, expect, it } from 'vitest';
import {
  cosine,
  rankByCosine,
  rankMemories,
  rankMemoriesHybrid,
  tokenize,
  type Vectorizable
} from '@/lib/cognitive/retrieval';

/**
 * Phase 3 的第一块砖：关键词召回。
 *
 * 此前的读侧是按 recordedAt 倒序取前 8 条，和用户这一轮问什么完全无关——
 * 那不是检索，是「最近说过什么」。这一片把它换成按重合度排序，
 * 并且要求：查不出任何相关项时必须退回原来的时间顺序，不许比现状更差。
 *
 * 余弦和 RRF 混合在这一片（5d）。图扩展和 Reranker 不在：前者要 MemoryRelation 表，
 * 后者要一次额外的模型调用，都还不存在。
 */

interface Item extends Vectorizable {
  id: string;
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

/** 单条造：向量不给就当这一行还没算过。 */
function doc(id: string, content: string, options: { recordedAt?: string; vector?: Float32Array } = {}): Item {
  return { id, content, recordedAt: options.recordedAt ?? '2026-11-01T00:00:00.000Z', vector: options.vector };
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

describe('向量那一路：余弦与混合排序', () => {
  const v = (...values: number[]) => new Float32Array(values);

  it('同向 1、正交 0、反向 -1', () => {
    expect(cosine(v(1, 0), v(1, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0);
    expect(cosine(v(1, 0), v(-1, 0))).toBeCloseTo(-1);
  });

  it('接受普通数组，不必先转成 Float32Array', () => {
    expect(cosine([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2);
  });

  it('长度不等或谁模长为 0 都返回 0，不算出 NaN', () => {
    expect(cosine(v(1, 2, 3), v(1, 2))).toBe(0);
    expect(cosine(v(0, 0), v(1, 1))).toBe(0);
    expect(Number.isNaN(cosine(v(0, 0), v(0, 0)))).toBe(false);
  });

  it('没带向量的行不抢位：排在带向量的之后，但一条都不丢', () => {
    const rows = [
      doc('m1', '我在用 Prisma', { recordedAt: '2026-11-01T00:00:00.000Z', vector: v(0, 1) }),
      doc('m2', '我住在杭州', { recordedAt: '2026-11-02T00:00:00.000Z' }),
      doc('m3', '我喜欢猫', { recordedAt: '2026-11-03T00:00:00.000Z', vector: v(1, 0) })
    ];

    const ranked = rankByCosine(v(1, 0), rows, { limit: 8 });

    expect(ranked.map((item) => item.id)).toEqual(['m3', 'm1', 'm2']);
  });

  it('余弦相同的按时间倒序，新的在前', () => {
    const rows = [
      doc('old', '旧的说法', { recordedAt: '2026-10-01T00:00:00.000Z', vector: v(1, 0) }),
      doc('new', '新的说法', { recordedAt: '2026-11-01T00:00:00.000Z', vector: v(1, 0) })
    ];

    expect(rankByCosine(v(1, 0), rows, { limit: 8 }).map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('一个词都不重合的那一条，靠向量进得了前八——这是关键词永远捞不回的那批', () => {
    const rows = [
      doc('gold', '周末我和现主管聊了转岗的事', {
        recordedAt: '2026-10-20T00:00:00.000Z',
        vector: v(1, 0.9, 0.1)
      }),
      doc('noise1', '今天天气不错', { recordedAt: '2026-11-03T00:00:00.000Z', vector: v(0, 0, 1) }),
      doc('noise2', '项目用 Next.js 15', { recordedAt: '2026-11-02T00:00:00.000Z', vector: v(0.1, 0, 1) })
    ];

    // 查询和 gold 那句共享不了任何 token：关键词这一路给它的分数是 0。
    expect(rankMemories('汇报', rows, { limit: 8 })[0]?.id).not.toBe('gold');

    const ranked = rankMemoriesHybrid('汇报', v(0.99, 0.9, 0.05), rows, { limit: 8 });
    expect(ranked[0]?.id).toBe('gold');
  });

  it('两边都靠前的那条赢过只在一边靠前的', () => {
    const rows = [
      doc('both', '汇报 汇报', { recordedAt: '2026-10-01T00:00:00.000Z', vector: v(1, 0) }),
      doc('lexical', '汇报 汇报 汇报', { recordedAt: '2026-10-02T00:00:00.000Z', vector: v(0, 1) }),
      doc('semantic', '别的说法', { recordedAt: '2026-10-03T00:00:00.000Z', vector: v(1, 0.05) })
    ];

    const ranked = rankMemoriesHybrid('汇报', v(1, 0), rows, { limit: 3 });

    expect(ranked[0]?.id).toBe('both');
    expect(ranked.map((item) => item.id)).toEqual(['both', 'lexical', 'semantic']);
  });

  it('关键词没话说时混合等于纯余弦；向量一行都没有时混合等于纯关键词', () => {
    const rows = [
      doc('a', '今天天气不错', { recordedAt: '2026-11-03T00:00:00.000Z', vector: v(0, 1) }),
      doc('b', '今天天气不错', { recordedAt: '2026-11-02T00:00:00.000Z', vector: v(1, 0) })
    ];

    // 查询「汇报」对两行都是 0 分：这一路不给名次，剩下的交给余弦。
    expect(rankMemoriesHybrid('汇报', v(1, 0), rows, { limit: 8 }).map((item) => item.id)).toEqual(['b', 'a']);

    const unvectorised = rows.map((row) => ({ ...row, vector: undefined }));
    expect(rankMemoriesHybrid('天气', v(1, 0), unvectorised, { limit: 8 })).toEqual(
      rankMemories('天气', unvectorised, { limit: 8 })
    );
  });

  it('不传查询向量就一字不差退回关键词那一路：今天的读侧行为不许被这改动带偏', () => {
    const rows = [
      doc('m1', '我在用 Prisma', { recordedAt: '2026-11-01T00:00:00.000Z', vector: v(0, 1) }),
      doc('m2', '我住在杭州', { recordedAt: '2026-11-02T00:00:00.000Z', vector: v(1, 0) })
    ];

    expect(rankMemoriesHybrid('杭州', undefined, rows, { limit: 8 })).toEqual(rankMemories('杭州', rows, { limit: 8 }));
  });

  it('正交、反向和维度不匹配的向量不会给关键词结果加分', () => {
    const rows = [
      doc('exact', '杭州', { recordedAt: '2026-11-01T00:00:00.000Z' }),
      doc('orthogonal', '杭州', { vector: v(0, 1), recordedAt: '2026-10-03T00:00:00.000Z' }),
      doc('opposite', '杭州', { vector: v(-1, 0), recordedAt: '2026-10-02T00:00:00.000Z' }),
      doc('mismatch', '杭州', { vector: v(1, 0, 0), recordedAt: '2026-10-01T00:00:00.000Z' })
    ];
    expect(rankMemoriesHybrid('杭州', v(1, 0), rows, { limit: 1 })[0]?.id).toBe('exact');
  });

  it('支持全角关键词和连续中文中的单字查询', () => {
    const rows = [
      doc('recent', '周末去公园', { recordedAt: '2026-11-01T00:00:00.000Z' }),
      doc('match', '我给猫起名叫Ｐｉｘｅｌ', { recordedAt: '2026-10-01T00:00:00.000Z' })
    ];
    expect(rankMemories('猫', rows, { limit: 1 })[0]?.id).toBe('match');
    expect(rankMemories('Pixel', rows, { limit: 1 })[0]?.id).toBe('match');
  });

  it('名额仍是截断的那个数，混合不许把 8 条变成 9 条', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      doc(`m${index}`, `说法 ${index}`, {
        recordedAt: new Date(Date.UTC(2026, 10, 1 + index)).toISOString(),
        vector: v(1, index / 100)
      })
    );

    expect(rankMemoriesHybrid('说法', v(1, 0), rows, { limit: 8 })).toHaveLength(8);
  });

  it('不修改传进来的数组', () => {
    const rows = [doc('m1', '我在用 Prisma', { vector: v(0, 1) }), doc('m2', '我住在杭州', { vector: v(1, 0) })];
    const before = rows.map((item) => item.id);

    rankMemoriesHybrid('杭州', v(1, 0), rows, { limit: 2 });

    expect(rows.map((item) => item.id)).toEqual(before);
  });
});
