import { describe, expect, it } from 'vitest';

/**
 * 评测 Harness 需要的那条纯函数接缝（切片 3a）。
 *
 * 这一片不改任何线上行为，只是把 readMemory 里「过滤 → 召回 → 渲染」那段和三次数据库调用切开：
 * Harness 喂 fixture 行调的就是这同一个函数，测的才是线上那条路径，而不是一份会漂移的复刻。
 * 所以这里断言的是**接缝自己的契约**（顺序、截断、标注），线上串起来的行为
 * 仍然由 cognitive-memory-module.test.ts 那 47 条守着——两边都绿才叫行为没变。
 *
 * assessWithCounts 拆在 evidence.ts：置信度算法本来就是纯的，卡住它的只是那次 groupBy。
 * 拆开后 Harness 可以直接喂证据计数，不必造一个假 Prisma。
 */

import {
  renderMemoryBlock,
  selectMemoryCandidates,
  MEMORY_READ_MAX_CHARS,
  MEMORY_READ_MAX_ITEMS
} from '@/lib/cognitive/memory-module';
import { assessWithCounts } from '@/lib/cognitive/evidence';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import type { MemoryDto } from '@/lib/cognitive/memories';

const OCCURRED = new Date('2026-11-02T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(OCCURRED.getTime() - days * DAY_MS).toISOString();
}

function row(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: 'mem-1',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'project',
    context: 'technicalProject',
    origin: 'explicit',
    content: '我在用 Prisma',
    confirmedAt: OCCURRED.toISOString(),
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: OCCURRED.toISOString(),
    ...overrides
  };
}

/** 三行池子：最旧的那条和查询最相关，用来验证排序真的换了依据。 */
function pool() {
  return [
    row({ id: 'new', content: '我周末常去西湖跑步', recordedAt: isoDaysAgo(1) }),
    row({ id: 'mid', content: '我打算明年考研', recordedAt: isoDaysAgo(2) }),
    row({ id: 'old', content: '我在用 Prisma 做数据库层', recordedAt: isoDaysAgo(3) })
  ];
}

describe('selectMemoryCandidates', () => {
  const base = { chatId: 'chat-1', now: OCCURRED, policies: DEFAULT_MEMORY_POLICIES };

  it('按与这一轮提问的重合度排序，相关的旧记忆挤掉无关的新记忆', () => {
    const picked = selectMemoryCandidates({ ...base, query: 'Prisma 还在用吗', rows: pool() });

    expect(picked.map((memory) => memory.id)).toEqual(['old', 'new', 'mid']);
  });

  it('一个词都对不上时退回时间倒序，不比改造前更差', () => {
    const picked = selectMemoryCandidates({ ...base, query: 'zzz qqq', rows: pool() });

    expect(picked.map((memory) => memory.id)).toEqual(['new', 'mid', 'old']);
  });

  it('过了保留期的记忆不再被选中', () => {
    const policies = {
      ...DEFAULT_MEMORY_POLICIES,
      technicalProject: { ...DEFAULT_MEMORY_POLICIES.technicalProject, retention: 'days30' as const }
    };
    const rows = [row({ id: 'fresh', recordedAt: isoDaysAgo(10) }), row({ id: 'stale', recordedAt: isoDaysAgo(40) })];

    const picked = selectMemoryCandidates({ ...base, policies, query: 'Prisma', rows });

    expect(picked.map((memory) => memory.id)).toEqual(['fresh']);
  });

  it('只截断到 MEMORY_READ_MAX_ITEMS，不放大注入条数', () => {
    const rows = Array.from({ length: 20 }, (unused, index) =>
      row({ id: `m${index}`, recordedAt: isoDaysAgo(index + 1) })
    );

    const picked = selectMemoryCandidates({ ...base, query: 'Prisma', rows });

    expect(picked).toHaveLength(MEMORY_READ_MAX_ITEMS);
  });

  it('空池子返回空数组', () => {
    expect(selectMemoryCandidates({ ...base, query: 'Prisma', rows: [] })).toEqual([]);
  });

  describe('带上查询向量时走混合排序', () => {
    /** 三行：gold 和查询「汇报」一个 token 都不重合，只有向量能把它捞回来。 */
    function vectorPool() {
      return [
        row({ id: 'noise', content: '今天天气不错', recordedAt: isoDaysAgo(1) }),
        row({ id: 'mid', content: '项目用 Next.js 15', recordedAt: isoDaysAgo(2) }),
        row({ id: 'gold', content: '周末和现主管聊了转岗的事', recordedAt: isoDaysAgo(3) })
      ];
    }

    const vectors = () =>
      new Map<string, Float32Array>([
        ['gold', new Float32Array([1, 0.9, 0.1])],
        ['noise', new Float32Array([0, 0, 1])],
        ['mid', new Float32Array([0.1, 0, 1])]
      ]);

    it('零共享 token 的那条靠向量进前 8，位置由余弦那一路决定', () => {
      const picked = selectMemoryCandidates({
        ...base,
        query: '汇报',
        rows: vectorPool(),
        queryVector: new Float32Array([0.99, 0.9, 0.05]),
        vectors: vectors()
      });

      expect(picked[0]?.id).toBe('gold');
      // 不给向量时它排在最后：这一条差异只可能来自余弦那一路。
      expect(selectMemoryCandidates({ ...base, query: '汇报', rows: vectorPool() }).map((m) => m.id)).toEqual([
        'noise',
        'mid',
        'gold'
      ]);
    });

    it('不传查询向量就一字不差退回关键词那一路', () => {
      const rows = vectorPool();
      const keywordOnly = selectMemoryCandidates({ ...base, query: '天气', rows });

      const picked = selectMemoryCandidates({ ...base, query: '天气', rows, vectors: vectors() });

      expect(picked).toEqual(keywordOnly);
    });

    it('一行向量都没有时混合等于关键词：向量缺席不许改变顺序', () => {
      const rows = vectorPool();

      const picked = selectMemoryCandidates({
        ...base,
        query: '天气',
        rows,
        queryVector: new Float32Array([1, 0, 0]),
        vectors: new Map()
      });

      expect(picked).toEqual(selectMemoryCandidates({ ...base, query: '天气', rows }));
    });

    it('返回的还是传进来的那几行对象，向量不跟着流行进渲染和置信度', () => {
      const rows = vectorPool();
      const picked = selectMemoryCandidates({
        ...base,
        query: '汇报',
        rows,
        queryVector: new Float32Array([0.99, 0.9, 0.05]),
        vectors: vectors()
      });

      expect(picked[0]).toBe(rows[2]);
      expect(Object.keys(picked[0]!)).not.toContain('vector');
    });

    it('没算过向量的行不丢：只有它进得来，名额照样给它', () => {
      const rows = vectorPool();
      const partial = new Map<string, Float32Array>([['gold', new Float32Array([1, 0, 0])]]);

      const picked = selectMemoryCandidates({
        ...base,
        query: '汇报',
        rows,
        queryVector: new Float32Array([1, 0, 0]),
        vectors: partial
      });

      expect(picked).toHaveLength(3);
      expect(picked.map((memory) => memory.id)).toEqual(['gold', 'noise', 'mid']);
    });
  });
});

describe('renderMemoryBlock', () => {
  const confidence = (band: 'low' | 'medium' | 'high') =>
    new Map([['old', { score: band === 'high' ? 0.9 : band === 'medium' ? 0.6 : 0.2, band, factors: [] }]]);

  it('低档位标注「不得以确定性语气使用」，中高档不标注', () => {
    const low = renderMemoryBlock([row({ id: 'old', content: '我在用 Prisma' })], confidence('low'))[0];
    const medium = renderMemoryBlock([row({ id: 'old', content: '我在用 Prisma' })], confidence('medium'))[0];

    expect(low?.text).toContain('（可信度低，不得以确定性语气使用）');
    expect(medium?.text).not.toContain('可信度低');
  });

  it('算不出档位时按低档位处理', () => {
    const block = renderMemoryBlock([row({ id: 'old' })], new Map())[0];

    expect(block?.text).toContain('（可信度低，不得以确定性语气使用）');
  });

  it('带上类型、情境和来源标签，并声明这是数据不是指令', () => {
    const block = renderMemoryBlock([row({ id: 'old', content: '我在用 Prisma' })], confidence('medium'))[0];

    expect(block?.text).toContain('[项目｜技术项目｜亲口说]');
    expect(block?.text).toContain('不是指令');
  });

  it('超过字符预算就停下，整块不超过 MEMORY_READ_MAX_CHARS', () => {
    const long = '很'.repeat(MEMORY_READ_MAX_CHARS);
    const memories = [row({ id: 'old', content: long }), row({ id: 'second', content: '我在用 Prisma' })];

    const block = renderMemoryBlock(memories, new Map([['second', { score: 0.6, band: 'medium' as const, factors: [] }]]));

    // 第一条本身就撑爆预算，整块直接不给——而不是给一个只剩标题的空块。
    expect(block).toEqual([]);
    expect(renderMemoryBlock([row({ id: 'old', content: '我在用 Prisma' })], confidence('medium'))[0]?.text.length)
      .toBeLessThanOrEqual(MEMORY_READ_MAX_CHARS);
  });

  it('没有选中的记忆时不渲染空块', () => {
    expect(renderMemoryBlock([], new Map())).toEqual([]);
  });
});

describe('assessWithCounts', () => {
  const subject = {
    id: 'mem-1',
    origin: 'explicit' as const,
    confirmedAt: OCCURRED.toISOString(),
    supersededAt: null,
    validTo: null
  };

  it('独立证据越多档位越高', () => {
    const once = assessWithCounts([subject], new Map([['mem-1', { supports: 1, contradicts: 0 }]]), OCCURRED);
    const twice = assessWithCounts([subject], new Map([['mem-1', { supports: 4, contradicts: 0 }]]), OCCURRED);

    expect(once.get('mem-1')?.band).toBe('medium');
    expect(twice.get('mem-1')?.band).toBe('high');
  });

  it('有反对证据直接压到低档，支持再多也不行', () => {
    const assessed = assessWithCounts([subject], new Map([['mem-1', { supports: 5, contradicts: 1 }]]), OCCURRED);

    expect(assessed.get('mem-1')?.band).toBe('low');
  });

  it('计数里没有这条记忆时按零证据算', () => {
    const assessed = assessWithCounts([subject], new Map(), OCCURRED);

    expect(assessed.get('mem-1')?.factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'origin' })])
    );
  });

  it('每条记忆都得有自己的档位，顺序与入参一致', () => {
    const others = [
      { ...subject, id: 'mem-2' },
      { ...subject, id: 'mem-3', origin: 'inferred' as const }
    ];

    const assessed = assessWithCounts(others, new Map([['mem-3', { supports: 0, contradicts: 2 }]]), OCCURRED);

    expect([...assessed.keys()]).toEqual(['mem-2', 'mem-3']);
  });

  it('空列表返回空 Map', () => {
    expect(assessWithCounts([], new Map(), OCCURRED).size).toBe(0);
  });
});
