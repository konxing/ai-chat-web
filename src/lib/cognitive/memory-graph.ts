import { MEMORY_CONTEXTS, type MemoryContext, type MemoryType } from './policy';
import type { MemoryDto } from './memories';
import type { TimelineEdge } from './timeline';

/**
 * 记忆网络的派生逻辑（任务书 8.2）。
 *
 * 这一片**不建表**。库里已经存在三种关系——演化边（`MemoryRevision`）、同一轮对话（`MemoryItem.chatId`）、
 * 同一条洞察的引用（`ReflectionCitation`）——它们本来就在写、在读（时间线、记忆面板、洞察一屏各读各的），
 * 这一片只是把同一批行画第二次。所以：
 *
 * 一、**没有「关联」这回事，只有「已经存在的关系」**。任务书 2a 那次阈值校准的结论就是不建 `MemoryRelation`
 * （本文档 2a 那节，`cognitive-memory-graph.test.ts` 用一条静态用例钉住）：一旦为画图加一张边表，
 * 它就成了需要维护的第二真相，而它的维护者只能是猜。
 *
 * 二、**同主题不成边**。七个主题乘以两百行是一把糊在一起的毛线球，画出来好看、读出来没有信息量。
 * 主题只做分组，界面上以「主题」的颜色出现，不以线的形式出现。
 *
 * 三、**星形，不是两两全连**。同一场对话里的 50 条记忆，真实的关系是「它们都发生在那一场对话」，
 * 不是「两两之间各有一层关系」。全连给 1225 条边，星形给 49 条，而两种画法的可读性差别是零。
 *
 * 四、**预算要说出来**。节点 ≤120、边 ≤240，超了就留最近那批并把 `capped` 交给界面。
 * 宁可明说「这里画不全」，也不把整库塞进一个 SVG 让浏览器转圈。
 */

/** 画布上限。两份读列表各自的硬上限是 200 行，这里留出的余量足够让图不吞掉整库。 */
export const GRAPH_MAX_NODES = 120;
export const GRAPH_MAX_EDGES = 240;

/** 一条洞察引用了哪条记忆。只取这两列，正文与洞察内容都不进这里。 */
export interface GraphCitation {
  reflectionId: string;
  memoryId: string;
}

export interface MemoryGraphSource {
  memories: MemoryDto[];
  /** 演化边（复用时间线那份四列形状，不解密理由）。 */
  edges: TimelineEdge[];
  citations: GraphCitation[];
}

export type GraphEdgeKind = 'update' | 'sameChat' | 'coCitation';

export interface GraphNode {
  id: string;
  content: string;
  type: MemoryType;
  context: MemoryContext;
  chatId: string | null;
  /** 已被更新的旧说法在图上仍要出现——它正是那条边的另一端——但画法不一样。 */
  isCurrent: boolean;
  recordedAt: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface GraphGroup {
  context: MemoryContext;
  nodeIds: string[];
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  capped: { nodes: boolean; edges: boolean };
  /** 截断之前的真实条数：`capped` 那句提示要说的是这个数，不是画布上的数。 */
  totalNodes: number;
  totalEdges: number;
}

export function deriveMemoryGraph({ memories, edges, citations }: MemoryGraphSource): MemoryGraph {
  const ordered = orderNodes(memories);
  const retained = ordered.slice(-GRAPH_MAX_NODES);
  const present = new Set(retained.map((node) => node.id));
  const byId = new Map(retained.map((node) => [node.id, node]));

  const candidates: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, kind: GraphEdgeKind) => {
    if (from === to) return;
    const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ from, to, kind });
  };

  // ① 演化边：先画。旧说法 → 新说法是这张图里唯一有方向的、也是唯一不需要解释的关系。
  for (const revision of [...edges].sort(compareRevisionEdges)) {
    if (!revision.previousId) continue;
    if (!present.has(revision.memoryId) || !present.has(revision.previousId)) continue;
    push(revision.previousId, revision.memoryId, 'update');
  }
  // ② 同一场对话：星形挂到这段对话里最早记下的那一条。
  for (const group of groupBy(retained, (node) => node.chatId)) {
    if (group.members.length < 2) continue;
    const anchor = group.members[0]!;
    for (const member of group.members.slice(1)) push(anchor.id, member.id, 'sameChat');
  }
  // ③ 共引用：同一条洞察一起引用过的记忆之间连边，同样星形。
  // 引用行先按 (reflectionId, memoryId) 排：读回来的那批是「最近 200 条、按时间倒序」，
  // 那个次序不是这里的输入契约，靠它决定边的先后就等于让上限一截、边的先后跟着晃。
  const citationRows = citations.filter((row) => present.has(row.memoryId)).sort(compareCitations);
  for (const group of groupBy(citationRows, (row) => row.reflectionId)) {
    const members = distinctMembers(group.members, byId);
    if (members.length < 2) continue;
    const anchor = members[0]!;
    for (const member of members.slice(1)) push(anchor.id, member.id, 'coCitation');
  }

  return {
    nodes: retained,
    edges: candidates.slice(0, GRAPH_MAX_EDGES),
    groups: buildGroups(retained),
    capped: { nodes: ordered.length > GRAPH_MAX_NODES, edges: candidates.length > GRAPH_MAX_EDGES },
    totalNodes: ordered.length,
    totalEdges: candidates.length
  };
}

function orderNodes(memories: MemoryDto[]): GraphNode[] {
  const taken = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const row of memories) {
    // 撤回的说法不再是一个立场。留着它等于把「用户已经不要了」画成图上还在亮着的一个点。
    if (row.origin === 'retracted' || taken.has(row.id)) continue;
    taken.add(row.id);
    nodes.push({
      id: row.id,
      content: row.content,
      type: row.type,
      context: row.context,
      chatId: row.chatId,
      isCurrent: row.supersededAt === null,
      recordedAt: row.recordedAt
    });
  }
  return nodes.sort(compareNodes);
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id);
}

function compareRevisionEdges(left: TimelineEdge, right: TimelineEdge): number {
  const from = left.previousId ?? '';
  return from.localeCompare(right.previousId ?? '') || left.memoryId.localeCompare(right.memoryId);
}

function compareCitations(left: GraphCitation, right: GraphCitation): number {
  return left.reflectionId.localeCompare(right.reflectionId) || left.memoryId.localeCompare(right.memoryId);
}

/**
 * 按 key 分组，组内成员保持传入顺序的「最早优先」。
 * 传入的列表已经按 recordedAt→id 排过，所以组里第一个就是锚点，不需要再排一次。
 */
function groupBy<T>(rows: T[], keyOf: (row: T) => string | null): { members: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return [...buckets.values()].map((members) => ({ members }));
}

/** 引用行可能把同一对记忆写两遍（库里没有约束挡这件事），图上只能是一个点。 */
function distinctMembers(rows: { memoryId: string }[], byId: Map<string, GraphNode>): GraphNode[] {
  const picked = new Map<string, GraphNode>();
  for (const row of rows) {
    const node = byId.get(row.memoryId);
    if (node && !picked.has(node.id)) picked.set(node.id, node);
  }
  return [...picked.values()].sort(compareNodes);
}

function buildGroups(nodes: GraphNode[]): GraphGroup[] {
  return MEMORY_CONTEXTS.map((context) => ({
    context,
    nodeIds: nodes
      .filter((node) => node.context === context)
      .map((node) => node.id)
      .sort((left, right) => left.localeCompare(right))
  })).filter((group) => group.nodeIds.length > 0);
}
