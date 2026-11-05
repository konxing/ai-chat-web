import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deriveMemoryGraph, type MemoryGraphSource } from '@/lib/cognitive/memory-graph';
import type { MemoryDto } from '@/lib/cognitive/memories';

/**
 * 记忆网络的派生逻辑（任务书 8.2）。
 *
 * 这一片的命门是「网络不是一张新图，是老关系换个画法」：边只能从库里**已经存在**的关系推，
 * 不建 `MemoryRelation`、不做相似度、不猜「大概有关」。所以这里的用例分成两层——
 * 一层钉「四种来源各自只产出它该产出的边」，一层钉「不该产出的东西一条都不产出」
 * （同主题不成边、空库不编节点、预算截断要说话）。
 */

const MAX_NODES = 120;
const MAX_EDGES = 240;

function memory(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: 'm-1',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'fact',
    context: 'general',
    origin: 'explicit',
    content: '我在做 family-ai-chat。',
    confirmedAt: '2026-11-01T10:00:00.000Z',
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: '2026-11-01T10:00:00.000Z',
    ...overrides
  };
}

function edge(memoryId: string, previousId: string | null, createdAt = '2026-11-02T10:00:00.000Z') {
  return { memoryId, previousId, action: 'superseded' as const, createdAt };
}

function citation(reflectionId: string, memoryId: string) {
  return { reflectionId, memoryId };
}

function source(overrides: Partial<MemoryGraphSource> = {}): MemoryGraphSource {
  return { memories: [], edges: [], citations: [], ...overrides };
}

describe('deriveMemoryGraph — 节点', () => {
  it('每条输入记忆是一个节点，id 与内容原样带出，不新增也不合并', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [memory({ id: 'a', content: '甲' }), memory({ id: 'b', content: '乙', chatId: 'chat-2' })]
      })
    );
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['a', 'b']);
    expect(graph.nodes.find((node) => node.id === 'a')?.content).toBe('甲');
  });

  it('撤回的说法不摆进图：它现在不是用户的一个立场，只剩一条边连向它就是把「已撤回」画成「还在用」', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [
          memory({ id: 'new', origin: 'userConfirmed' }),
          memory({ id: 'old', origin: 'retracted' })
        ],
        edges: [edge('new', 'old')]
      })
    );
    expect(graph.nodes.map((node) => node.id)).toEqual(['new']);
    expect(graph.edges).toEqual([]);
  });

  it('重复的 id 只留第一个：两条同名节点会让界面显示一个假的分身', () => {
    const graph = deriveMemoryGraph(source({ memories: [memory({ id: 'a' }), memory({ id: 'a', content: '另一条' })] }));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.content).toBe('我在做 family-ai-chat。');
  });

  it('节点带着画图上要用的三个身份列：主题、是否已被取代、来源会话', () => {
    const graph = deriveMemoryGraph(source({ memories: [memory({ id: 'a', context: 'learning', supersededAt: '2026-11-03T10:00:00.000Z' })] }));
    expect(graph.nodes[0]).toMatchObject({
      id: 'a',
      context: 'learning',
      isCurrent: false,
      chatId: 'chat-1'
    });
  });
});

describe('deriveMemoryGraph — ① 演化边', () => {
  it('一条 SUPERSEDED 边画成「旧说法 → 新说法」，方向从 previousId 指向 memoryId', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [memory({ id: 'old', supersededAt: '2026-11-02T10:00:00.000Z' }), memory({ id: 'new' })],
        edges: [edge('new', 'old')]
      })
    );
    expect(graph.edges).toEqual([{ from: 'old', to: 'new', kind: 'update' }]);
  });

  it('previousId 为空的新写入不产边：「这条记忆被什么取代过」和「这条记忆是新写的」是两件事', () => {
    const graph = deriveMemoryGraph(source({ memories: [memory({ id: 'new' })], edges: [edge('new', null)] }));
    expect(graph.edges).toEqual([]);
  });

  it('边指向一个不在节点集合里的 id 时丢掉，不凭空造一个空节点', () => {
    const graph = deriveMemoryGraph(
      source({ memories: [memory({ id: 'new' })], edges: [edge('new', 'deleted-already')] })
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });
});

describe('deriveMemoryGraph — ② 同来源会话：星形，不是两两全连', () => {
  it('同一 chatId 的 N 条记忆挂到最早那条上：50 条给 49 条边，不是 1225 条', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      memory({
        id: `m-${String(index).padStart(2, '0')}`,
        chatId: 'chat-x',
        recordedAt: `2026-11-01T${String(10 + Math.floor(index / 6)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`
      })
    );
    const graph = deriveMemoryGraph(source({ memories: many }));
    expect(graph.edges).toHaveLength(49);
    const anchor = 'm-00';
    expect(graph.edges.every((e) => e.from === anchor)).toBe(true);
    expect(graph.edges.every((e) => e.kind === 'sameChat')).toBe(true);
  });

  it('锚点是这段对话里最早记下的那一条（按 recordedAt），不是输入数组的第一条', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [
          memory({ id: 'late', chatId: 'c', recordedAt: '2026-11-09T10:00:00.000Z' }),
          memory({ id: 'early', chatId: 'c', recordedAt: '2026-11-02T10:00:00.000Z' })
        ]
      })
    );
    expect(graph.edges).toEqual([{ from: 'early', to: 'late', kind: 'sameChat' }]);
  });

  it('没有 chatId 的记忆不参与这一段：来源会话为空时「一起说过」这句话没有依据', () => {
    const graph = deriveMemoryGraph(
      source({ memories: [memory({ id: 'a', chatId: null }), memory({ id: 'b', chatId: null })] })
    );
    expect(graph.edges).toEqual([]);
  });

  it('一条记忆自己不成一段：单元素的会话分组不产生自环', () => {
    const graph = deriveMemoryGraph(source({ memories: [memory({ id: 'solo' })] }));
    expect(graph.edges).toEqual([]);
  });
});

describe('deriveMemoryGraph — ③ 同主题只分组，不做边', () => {
  it('两条同主题、别的都不沾的记忆之间边数为 0，但分组里能看到它们', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [
          memory({ id: 'a', context: 'learning', chatId: 'chat-a' }),
          memory({ id: 'b', context: 'learning', chatId: 'chat-b' })
        ]
      })
    );
    expect(graph.edges).toEqual([]);
    expect(graph.groups).toEqual([{ context: 'learning', nodeIds: ['a', 'b'] }]);
  });

  it('分组按主题逐个摆出、组内按 id 定序：七个主题各两百条时会画成一把毛线球，所以它就不是画', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [
          memory({ id: 'b2', context: 'learning', chatId: 'chat-b' }),
          memory({ id: 'a1', context: 'general', chatId: 'chat-a' }),
          memory({ id: 'a2', context: 'general', chatId: 'chat-a2' })
        ]
      })
    );
    expect(graph.groups).toEqual([
      { context: 'general', nodeIds: ['a1', 'a2'] },
      { context: 'learning', nodeIds: ['b2'] }
    ]);
  });
});

describe('deriveMemoryGraph — ④ 共引用', () => {
  it('同一条洞察引用的两条记忆连一条边（星形挂到最早那条，不是两两全连）', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [
          memory({ id: 'x', chatId: 'chat-x', recordedAt: '2026-11-01T10:00:00.000Z' }),
          memory({ id: 'y', chatId: 'chat-y', recordedAt: '2026-11-05T10:00:00.000Z' }),
          memory({ id: 'z', chatId: 'chat-z', recordedAt: '2026-11-07T10:00:00.000Z' })
        ],
        citations: [citation('r-1', 'x'), citation('r-1', 'y'), citation('r-1', 'z')]
      })
    );
    const co = graph.edges.filter((e) => e.kind === 'coCitation');
    expect(co).toHaveLength(2);
    expect(co.every((e) => e.from === 'x')).toBe(true);
    expect(co.map((e) => e.to).sort()).toEqual(['y', 'z']);
  });

  it('两条洞察各引用同一条记忆，不产生任何边：共引用要的是「同一条洞察里一起出现过」', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [memory({ id: 'a', chatId: 'chat-a' }), memory({ id: 'b', chatId: 'chat-b' })],
        citations: [citation('r-1', 'a'), citation('r-2', 'a')]
      })
    );
    // 两条洞察都只引用了 a 这一条：谁也没「同时」引用过第二记忆，a 和 b 之间没有出现过关系。
    expect(graph.edges.filter((e) => e.kind === 'coCitation')).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('引用行指向已经不存在的记忆时跳过，不报错也不画幽灵', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [memory({ id: 'a', chatId: 'chat-a' }), memory({ id: 'b', chatId: 'chat-b' })],
        citations: [citation('r-1', 'a'), citation('r-1', 'purged')]
      })
    );
    expect(graph.edges.filter((e) => e.kind === 'coCitation')).toEqual([]);
  });
});

describe('deriveMemoryGraph — 去重与定序', () => {
  it('同一对节点的同来源重复引用只画一根线：库里两条引用行不等于图上两条边', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [memory({ id: 'a', chatId: 'chat-a' }), memory({ id: 'b', chatId: 'chat-b' })],
        citations: [citation('r-1', 'a'), citation('r-1', 'b'), citation('r-1', 'b')]
      })
    );
    expect(graph.edges).toEqual([{ from: 'a', to: 'b', kind: 'coCitation' }]);
  });

  /**
   * 上一用例钉的是「同一对节点重复引用只画一根线」，这一条钉的是优先序本身：
   * 派生层按 ①update ②sameChat ③coCitation 的顺序收边，先到先得。
   * 顺序反了会怎样？图上那条边的 kind 变了，界面图例里它就是另一种意思——
   * 「它们在同一条洞察里被一起引用过」取代了「前者被后者更新」。
   */
  it('同一对节点被两种来源命中时只留一条边，且演化那条优先：先有「旧说法变成新说法」，再谈「反正是一起说的」', () => {
    const graph = deriveMemoryGraph(
      source({
        memories: [
          memory({ id: 'old', supersededAt: '2026-11-02T10:00:00.000Z', recordedAt: '2026-11-01T10:00:00.000Z' }),
          memory({ id: 'new', recordedAt: '2026-11-02T10:00:00.000Z' })
        ],
        edges: [edge('new', 'old')],
        citations: [citation('r-1', 'old'), citation('r-1', 'new')]
      })
    );
    expect(graph.edges).toEqual([{ from: 'old', to: 'new', kind: 'update' }]);
  });

  it('节点与边都是确定序：同一份输入跑两次，逐字节相同', () => {
    const input = source({
      memories: [
        memory({ id: 'b', context: 'learning', chatId: 'chat-1', recordedAt: '2026-11-03T10:00:00.000Z' }),
        memory({ id: 'a', chatId: 'chat-1', recordedAt: '2026-11-01T10:00:00.000Z' })
      ],
      citations: [citation('r-1', 'a'), citation('r-1', 'b')]
    });
    const first = deriveMemoryGraph(input);
    expect(deriveMemoryGraph(input)).toEqual(first);
    expect(first.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  /**
   * 「同一份输入跑两次」还不够：读回来的那批引用行的次序不是契约的一部分
   * （`listCitationEdges` 按时间倒序取最近 200 条，`listMemories` 又是另一套序），
   * 派生层要是靠传入次序决定边的先后，上限一截、边的先后就跟着晃。
   * 打乱引用行必须给出逐字节相同的图——定序是这里的事。
   */
  it('引用行的传入次序打乱，边一条不多一条不少、先后也一样：定序不靠读的那侧碰巧排好', () => {
    const memories = [
      memory({ id: 'a', chatId: null }),
      memory({ id: 'b', chatId: null }),
      memory({ id: 'c', chatId: null }),
      memory({ id: 'd', chatId: null })
    ];
    const inOrder = deriveMemoryGraph(
      source({
        memories,
        citations: [citation('r-1', 'a'), citation('r-1', 'b'), citation('r-2', 'c'), citation('r-2', 'd')]
      })
    );
    const shuffled = deriveMemoryGraph(
      source({
        memories: [...memories].reverse(),
        citations: [citation('r-2', 'd'), citation('r-1', 'b'), citation('r-2', 'c'), citation('r-1', 'a')]
      })
    );
    expect(shuffled).toEqual(inOrder);
    expect(inOrder.edges).toEqual([
      { from: 'a', to: 'b', kind: 'coCitation' },
      { from: 'c', to: 'd', kind: 'coCitation' }
    ]);
  });
});

describe('deriveMemoryGraph — 预算', () => {
  function crowd(count: number): MemoryDto[] {
    return Array.from({ length: count }, (_, index) =>
      memory({
        id: `m-${String(index).padStart(3, '0')}`,
        chatId: 'chat-big',
        recordedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString()
      })
    );
  }

  it('节点超过上限时留最近那批，并说 capped：宁可画不全，也不把整库搬进一个 SVG', () => {
    const graph = deriveMemoryGraph(source({ memories: crowd(MAX_NODES + 30) }));
    expect(graph.nodes).toHaveLength(MAX_NODES);
    expect(graph.capped.nodes).toBe(true);
    expect(graph.totalNodes).toBe(MAX_NODES + 30);
    // 留下的是最近的那批——最早那 30 条不在画布上。
    expect(graph.nodes.some((node) => node.id === 'm-000')).toBe(false);
    expect(graph.nodes.some((node) => node.id === 'm-149')).toBe(true);
  });

  it('没超上限时 capped 说 false，totalNodes 是真实条数：提示不许在不需要时摆出来', () => {
    const graph = deriveMemoryGraph(source({ memories: crowd(10) }));
    expect(graph.capped).toEqual({ nodes: false, edges: false });
    expect(graph.totalNodes).toBe(10);
  });

  it('边数上限同样说话：共引用组叠出 341 条边时只画 240 条，并说这里画不全', () => {
    const crowdNodes = Array.from({ length: MAX_NODES }, (_, index) =>
      memory({
        id: `m-${String(index).padStart(3, '0')}`,
        chatId: null,
        recordedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString()
      })
    );
    const citations: { reflectionId: string; memoryId: string }[] = crowdNodes.map((row) => ({
      reflectionId: 'r-all',
      memoryId: row.id
    }));
    // 38 组各把 7 条记忆并到一条洞察里：每组星形 6 条边，彼此不重叠。
    for (let group = 0; group < 38; group += 1) {
      for (let offset = 0; offset < 7; offset += 1) {
        citations.push({ reflectionId: `r-${group}`, memoryId: `m-${String(group * 3 + offset).padStart(3, '0')}` });
      }
    }
    const graph = deriveMemoryGraph(source({ memories: crowdNodes, citations }));
    expect(graph.capped).toEqual({ nodes: false, edges: true });
    expect(graph.edges).toHaveLength(MAX_EDGES);
    expect(graph.totalEdges).toBe(119 + 38 * 6 - 6);
  });

  it('空输入给空的图，不是一句报错：库里只有两条记忆是今天的真实状况', () => {
    expect(deriveMemoryGraph(source())).toEqual({
      nodes: [],
      edges: [],
      groups: [],
      capped: { nodes: false, edges: false },
      totalNodes: 0,
      totalEdges: 0
    });
  });
});

describe('不建 MemoryRelation（钉住「零迁移派生」这个决定）', () => {
  it('schema 里没有 MemoryRelation 这张表：这张图靠派生，加表就是把它变成一份要维护的第二真相', () => {
    expect(readFileSync('prisma/schema.prisma', 'utf8')).not.toMatch(/model\s+MemoryRelation\b/);
  });

  it('src 里没有任何一处真的去访问 memoryRelation 这张表：一旦有人为了画得好看去加表或加读，这条先红', () => {
    // 只咬 `prisma.memoryRelation` / `tx.memoryRelation` 这种属性访问的形状。
    // 光看「文档里出现这个词」会咬到本文自己那句「不建 MemoryRelation」的判词——那是注释，不是读库。
    const offenders: string[] = [];
    for (const entry of readdirSync('src', { recursive: true, encoding: 'utf8' }) as string[]) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      const path = join('src', entry);
      if (/\b(?:prisma|tx|db)\.memoryRelation\b/.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
