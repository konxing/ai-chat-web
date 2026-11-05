import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GRAPH_MAX_EDGES as DERIVE_MAX_EDGES, GRAPH_MAX_NODES as DERIVE_MAX_NODES } from '@/lib/cognitive/memory-graph';
import { MEMORY_CONTEXTS } from '@/lib/cognitive/policy';
import { CONTEXT_LABELS } from '@/lib/cognitive/memory-display';
import type { MemoryGraph } from '@/lib/cognitive/memory-graph';
import {
  GRAPH_CONTEXT_COLORS,
  GRAPH_EDGE_LABELS,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  describeAssociationGate,
  describeGraphBudget,
  describeNotAGraph,
  isGraphDrawable,
  truncateNodeLabel
} from '@/lib/cognitive/memory-graph-display';

/**
 * 记忆网络那一屏的「说什么」层（任务书 8.2）。
 *
 * 和 memory-display.ts / reflection-display.ts 同一个理由：派生层和服务层都 import 了 prisma，
 * 客户端组件运行时引用它们会把数据库驱动拖进浏览器包。所以标签、句子、颜色搬在这个文件里，
 * 类型用 `import type` 引。这个边界本身有一条静态用例钉着，见最后一节。
 *
 * 这一片唯一需要被用例保护的立场是**空画布不许装成有内容**：
 * 没有边的时候画一圈点是「还没连起来」，不是「它们彼此相关」；
 * 点不够三个的时候两根线也不叫网络。所以 `isGraphDrawable` 和 `describeNotAGraph` 是一对，
 * 界面必须先问前者、再念后者，而不是自己临场编一句「暂时还没有数据」。
 */

function node(id: string) {
  return {
    id,
    content: '甲',
    type: 'fact' as const,
    context: 'general' as const,
    chatId: null,
    isCurrent: true,
    recordedAt: '2026-11-01T10:00:00.000Z'
  };
}

function edge(from: string, to: string) {
  return { from, to, kind: 'sameChat' as const };
}

function graph(overrides: Partial<MemoryGraph> = {}): MemoryGraph {
  return {
    nodes: [],
    edges: [],
    groups: [],
    capped: { nodes: false, edges: false },
    totalNodes: 0,
    totalEdges: 0,
    associationGated: 0,
    ...overrides
  };
}

function nodes(count: number) {
  return Array.from({ length: count }, (_unused, index) => node(`m-${index}`));
}

/** 画布上那行字的长度上限：这里是**写死的期望**，不是从实现里读回来的数——改成 25 就该让用例红。 */
const LABEL_MAX = 24;

describe('isGraphDrawable — 什么时候才配叫一张图', () => {
  it('有三个以上的点、并且至少一根线，才画 SVG', () => {
    expect(isGraphDrawable(graph({ nodes: nodes(3), edges: [edge('m-0', 'm-1')] }))).toBe(true);
  });

  it('点再多，一根线都没有就不画：散点看着像图，读出来什么也不是', () => {
    expect(isGraphDrawable(graph({ nodes: nodes(30), edges: [] }))).toBe(false);
  });

  it('点不足三个就不画：两个点加一根线说明不了「网络」这两个字', () => {
    expect(isGraphDrawable(graph({ nodes: nodes(2), edges: [edge('m-0', 'm-1')] }))).toBe(false);
  });
});

describe('describeNotAGraph — 画不出来时说的是哪个数', () => {
  it('一条记忆都没有时说的是「没有一个点」，不是「没有关联」', () => {
    expect(describeNotAGraph(0, 0, 0)).toBe('你还没有一条记忆，所以这张图上没有一个点。');
  });

  it('有记忆但推不出任何关系时，说的是那句「不猜」', () => {
    expect(describeNotAGraph(7, 0, 0)).toBe(
      '现在还不是一张图：你的 7 条记忆之间没有更新边，也没有共来源会话。图只从已经存在的关系里推导，不猜。'
    );
  });

  it('点不够但有连线时不许复用那句「没有更新边」：这时候线是有的，缺的是点', () => {
    expect(describeNotAGraph(2, 1, 0)).toBe(
      '2 个点、1 根线连不成一张图：这两个点之间确实有关系，可三个点以上的连线才叫网络。'
    );
  });

  /**
   * 闸门这一条是这一片新加的用例，它挡的是一句**当时会真的撒谎**的话：
   * 零线有可能是「同一场对话里的那些行被策略挡在关联池外」造成的，
   * 那时候说「没有共来源会话」就是拿系统的闸门冒充库里的空缺。
   */
  it('零线但有闸门时不许说「没有共来源会话」：那是闸门挡的，库里没有这件事没说出口', () => {
    expect(describeNotAGraph(7, 0, 2)).toBe(
      '现在还不是一张图：你的 7 条记忆之间有 2 条按你的情境策略不参与关联，' +
        '剩下这些之间既没有被更新的，也没有同一场对话里一起记下的。图只从已经存在的关系里推导，不猜。'
    );
  });

  it('闸门句只在零线时插进去：点太少那一支说的还是点数，跟闸门没关系', () => {
    expect(describeNotAGraph(2, 1, 5)).toBe(
      '2 个点、1 根线连不成一张图：这两个点之间确实有关系，可三个点以上的连线才叫网络。'
    );
  });

  it('没有记忆时闸门条数再大也不提：那 0 条记忆里没有任何一条，两句会互相打脸', () => {
    expect(describeNotAGraph(0, 0, 3)).toBe('你还没有一条记忆，所以这张图上没有一个点。');
  });
});

describe('describeAssociationGate — 闸门挡了几条就要说几条', () => {
  it('一条都没被挡时空串：不需要时报一句「没有东西被挡」是噪音', () => {
    expect(describeAssociationGate(0)).toBe('');
  });

  it('报的是条数，并且当场说清挡的只有关联线、不是那条记忆本身', () => {
    expect(describeAssociationGate(3)).toBe(
      '这张图上有 3 条记忆按你的情境策略不参与关联：图上不为它们画关联线，它们自己的更新关系照样画。'
    );
  });

  it('句子里只有条数：参数就是一个数字，界面因此不可能把某条记忆的正文带进这句提示', () => {
    const sentence = describeAssociationGate(12);
    expect(sentence.match(/\d+/g)).toEqual(['12']);
  });
});

describe('describeGraphBudget — 截断要说出来，不许静默', () => {
  it('没顶到上限时一句话都不说', () => {
    expect(describeGraphBudget(graph({ nodes: nodes(10), totalNodes: 10 }))).toEqual([]);
  });

  it('节点截断时报的是真实条数，不是画布上的点数', () => {
    const [sentence] = describeGraphBudget(
      graph({ nodes: nodes(GRAPH_MAX_NODES), capped: { nodes: true, edges: false }, totalNodes: 260 })
    );
    expect(sentence).toBe(`这里画不全：你一共有 260 条记忆，画布最多放 ${GRAPH_MAX_NODES} 个点，显示的是最近那批。`);
    expect(sentence).not.toContain('240');
  });

  it('边截断时同样报真实推导数', () => {
    const [sentence] = describeGraphBudget(
      graph({ edges: Array.from({ length: GRAPH_MAX_EDGES }, (_u, i) => edge(`m-${i}`, 'm-0')),
        capped: { nodes: false, edges: true },
        totalNodes: 120,
        totalEdges: 341 })
    );
    expect(sentence).toBe(`这里画不全：一共有 341 根线，画布最多画 ${GRAPH_MAX_EDGES} 根，剩下的没有画出来。`);
  });

  it('两处都截时先说点再说线，两句都给', () => {
    const sentences = describeGraphBudget(
      graph({ nodes: nodes(GRAPH_MAX_NODES), capped: { nodes: true, edges: true }, totalNodes: 200, totalEdges: 500 })
    );
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain('200 条记忆');
    expect(sentences[1]).toContain('500 根线');
  });
});

describe('图例：线的种类和点的颜色', () => {
  /**
   * 键集正好是这三种。「同一主题」不能出现在这里：派生层判过同主题不成边
   * （七个主题乘两百行是一把毛线球），图例要是留着它，界面就在承诺一张画不出来的线。
   */
  it('线只有三种，且没有「同主题」这一种', () => {
    expect(Object.keys(GRAPH_EDGE_LABELS).sort()).toEqual(['coCitation', 'sameChat', 'update']);
  });

  it('三种线各有说法，互不相同', () => {
    const labels = Object.values(GRAPH_EDGE_LABELS);
    expect(new Set(labels).size).toBe(3);
    expect(GRAPH_EDGE_LABELS.update).toBe('更新为');
    expect(GRAPH_EDGE_LABELS.sameChat).toBe('同一场对话里说过');
    expect(GRAPH_EDGE_LABELS.coCitation).toBe('同一条洞察里一起提到');
  });

  it('颜色按主题给，七个主题一个不漏、一个不重', () => {
    expect(Object.keys(GRAPH_CONTEXT_COLORS).sort()).toEqual([...MEMORY_CONTEXTS].sort());
    expect(Object.keys(GRAPH_CONTEXT_COLORS)).toEqual(Object.keys(CONTEXT_LABELS));
    expect(new Set(Object.values(GRAPH_CONTEXT_COLORS)).size).toBe(MEMORY_CONTEXTS.length);
  });

  /**
   * 主题在这张图上的角色是「点的颜色」，不是「一根线」。所以点的分组名复用记忆面板那套标签，
   * 两处对同一个主题的叫法不许漂移。
   */
  it('主题名复用 memory-display 的 CONTEXT_LABELS，不另起一套', () => {
    for (const context of MEMORY_CONTEXTS) {
      expect(CONTEXT_LABELS[context]).toBeTruthy();
    }
  });
});

describe('truncateNodeLabel — 画布上的那行字', () => {
  it('不超过上限时原样给出', () => {
    expect(truncateNodeLabel('我在用 Prisma')).toBe('我在用 Prisma');
  });

  it('正好等于上限时不加省略号', () => {
    const exact = '一'.repeat(LABEL_MAX);
    expect(truncateNodeLabel(exact)).toBe(exact);
  });

  it('超长时裁到上限并留省略号：SVG 里的文字撑破了布局就没有第二个画法能救', () => {
    const long = '记'.repeat(LABEL_MAX + 20);
    const result = truncateNodeLabel(long);
    expect(result).toBe(`${'记'.repeat(LABEL_MAX - 1)}…`);
    expect(result).not.toContain('记'.repeat(LABEL_MAX));
  });
});

describe('边界：这个文件不许把 prisma 拖进浏览器包', () => {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/lib/cognitive/memory-graph-display.ts'),
    'utf8'
  );

  it('除 import type 以外不引用任何运行时模块', () => {
    const valueImports = source
      .split('\n')
      .filter((line) => line.startsWith('import') && !line.startsWith('import type'));
    expect(valueImports).toEqual([]);
  });

  it('预算常量与派生层各写一份，值不许漂', () => {
    expect(GRAPH_MAX_NODES).toBe(DERIVE_MAX_NODES);
    expect(GRAPH_MAX_EDGES).toBe(DERIVE_MAX_EDGES);
  });
});
