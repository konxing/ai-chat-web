import type { GraphEdgeKind, MemoryGraph } from './memory-graph';
import type { MemoryContext } from './policy';

/**
 * 记忆网络那一屏的前端词汇：画不画得出来、画不出来时说哪句、图例叫什么、点涂什么色。
 *
 * 和 memory-display.ts 同一个理由：`memory-graph.ts`（运行时 import 了 policy.ts）和
 * `memories.ts` 都在服务端，客户端组件运行时引用它们会把 prisma 拖进浏览器包。
 * 这里只许有纯函数和常量，类型一律 `import type`，边界由用例钉住。
 *
 * 这一片要保护的立场只有一条：**画不出图的时候不许让它看着像有内容**。
 * 任务书 8.2 要的是「关联可视化」，而 2a 那次阈值校准的结论是不建边表、不猜关联
 * ——于是真实的库在大多数时候推不出几条边。这时界面上有三个诱惑：
 * 把散点连成装饰、写一句「暂无数据」糊过去、或者干脆不给入口。三个都不许：
 * `isGraphDrawable` 说不能画，`describeNotAGraph` 就得说清**为什么**不能画，
 * 而且说的必须是这批数据的真实条数。
 */

/**
 * 画布预算。派生层（`memory-graph.ts`）自己还有一份，两处各写是刻意的——
 * 那边 import 不到这里，这边不能 import 那边——漂移由用例钉住。
 */
export const GRAPH_MAX_NODES = 120;
export const GRAPH_MAX_EDGES = 240;

/** 节点标签的最长字数：SVG 里的文字不会自动换行，撑破了就没有第二种画法能救。 */
const LABEL_MAX = 24;

/**
 * 四种线的说法。`relation` 是 11-06 起库里有证据的关系行（同主题等）；
 * 其余三种是从已有行派生出来的布局线。键集里没有「同一主题」这一项：
 * 同主题只分组；要画线，得是写侧真的落了一条 SAME_TOPIC 的边（带来源消息做证据）。
 */
export const GRAPH_EDGE_LABELS: Record<GraphEdgeKind, string> = {
  relation: '有证据的关联',
  update: '更新为',
  sameChat: '同一场对话里说过',
  coCitation: '同一条洞察里一起提到'
};

/**
 * 点的颜色 = 主题。这是「同主题不成边」那条判词的另一半：
 * 主题在这张图上的角色是「点的颜色」而不是「一根线」，画得出分组也不造出一条解释不了的边。
 * 主题名复用 `memory-display.ts` 的 `CONTEXT_LABELS`（那边同样不带运行时依赖），这里只给色值；
 * 键集与它一致，由用例钉住。
 */
export const GRAPH_CONTEXT_COLORS: Record<MemoryContext, string> = {
  general: '#8a8f98',
  technicalProject: '#2f6fdb',
  learning: '#1f9d6b',
  personalGoal: '#c9781b',
  personalReflection: '#7a5bd0',
  emotionalSupport: '#d0446d',
  decisionMaking: '#3d8fa8'
};

/**
 * 三个条件同时成立才值得画 SVG：有线、点够三个、而且线不是只连着一对点。
 * 「点够三个」不是审美：两个点一根线说的是「这俩有关系」，那不是网络，
 * 用网络的样子画它会让人以为看见了全局结构。
 */
export function isGraphDrawable(graph: MemoryGraph): boolean {
  return graph.edges.length > 0 && graph.nodes.length >= 3;
}

/**
 * 画不出来时的那句话。三种情形分开说，因为「缺什么」不一样：
 * 没有记忆、有记忆但推不出关系、有关系但点太少。
 * 复用同一句「没有更新边」去描述第三种会当场说谎——那时候线是有的。
 *
 * 第三个参数是关联闸门挡掉的条数，它只改第二支：零线既可能是「库里本来就没有共来源会话」，
 * 也可能是「有，但那些行按情境策略不进关联池」。这两种在界面上必须不一样——
 * 把用户的开关读成他的数据的空缺，这一屏就在替他做他没做过的判断。
 */
export function describeNotAGraph(nodeCount: number, edgeCount: number, associationGated: number): string {
  if (nodeCount === 0) return '你还没有一条记忆，所以这张图上没有一个点。';
  if (edgeCount === 0) {
    if (associationGated > 0) {
      return (
        `现在还不是一张图：你的 ${nodeCount} 条记忆之间有 ${associationGated} 条按你的情境策略不参与关联，` +
        '剩下这些之间既没有被更新的，也没有同一场对话里一起记下的。图只从已经存在的关系里推导，不猜。'
      );
    }
    return `现在还不是一张图：你的 ${nodeCount} 条记忆之间没有更新边，也没有共来源会话。图只从已经存在的关系里推导，不猜。`;
  }
  return `${nodeCount} 个点、${edgeCount} 根线连不成一张图：这两个点之间确实有关系，可三个点以上的连线才叫网络。`;
}

/**
 * 关联闸门的提示。0 时给空串，由界面自己决定摆不摆——不需要时报一句「没东西被挡」是噪音。
 *
 * 这句只报条数，而且当场说清挡的是**线**不是**行**：那几条记忆仍然在图上，仍然能被点开。
 * 一句「这些记忆已隐藏」会把一个策略读成一次删除，那是这一屏最不该说的话。
 */
export function describeAssociationGate(associationGated: number): string {
  if (associationGated <= 0) return '';
  return (
    `这张图上有 ${associationGated} 条记忆按你的情境策略不参与关联：` +
    '图上不为它们画关联线，它们自己的更新关系照样画。'
  );
}

/**
 * 预算提示。说的是**截断前**的真实条数：`graph.nodes.length` 永远是画布上那几个点，
 * 拿它当「你一共有多少条」报出去，正好把这次截断本身瞒下来了。
 */
export function describeGraphBudget(graph: MemoryGraph): string[] {
  const sentences: string[] = [];
  if (graph.capped.nodes) {
    sentences.push(
      `这里画不全：你一共有 ${graph.totalNodes} 条记忆，画布最多放 ${GRAPH_MAX_NODES} 个点，显示的是最近那批。`
    );
  }
  if (graph.capped.edges) {
    sentences.push(
      `这里画不全：一共有 ${graph.totalEdges} 根线，画布最多画 ${GRAPH_MAX_EDGES} 根，剩下的没有画出来。`
    );
  }
  return sentences;
}

/** 画布上的节点文字：整条内容原样进 SVG 会撑破图，但截断要看得出是截断。 */
export function truncateNodeLabel(content: string): string {
  if (content.length <= LABEL_MAX) return content;
  return `${content.slice(0, LABEL_MAX - 1)}…`;
}
