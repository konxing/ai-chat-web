import type { MemoryRelation, MemoryRelationType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isMemoryUsable } from './retention';
import type { MemoryDto } from './memories';
import type { MemoryContext, MemoryPolicy } from './policy';
import { topicSignature } from './reflection-planner';

/**
 * 记忆关系（任务书 2.3）与两跳扩展（3.2）。
 *
 * 这一层只做三件事：把有确定证据的关系写成行、按需读出来、从种子做有限扩展。
 * 它不判断「两条记忆像不像」以外的语义——SUPPORTS / CONTRADICTS / CAUSES_WITH_EVIDENCE
 * 这些需要外部证据的类型，今天没有可信的生产者，就不自动写。
 * 按时间先后生成因果（任务书明确禁止）这条捷径在这里没有入口。
 *
 * 参数是任务书 3.2 的默认值，全部写成常量而不是散在调用点：
 * 深度 2、候选 30、注入 8、置信度下限 0.5。改它们要带着评测数字改，不是顺手调。
 */
export const GRAPH_MAX_DEPTH = 2;
export const GRAPH_MAX_NODES = 30;
export const GRAPH_MAX_INJECTED = 8;
export const GRAPH_MIN_CONFIDENCE = 0.5;
export const TOPIC_RELATIONS_PER_MEMORY = 3;
/** 同主题至少重合两个内容词——和反思成簇用的是同一条规则，不另造一套「像」的定义。 */
export const TOPIC_OVERLAP_MIN = 2;

/** 只取写关系需要的委托，测试里可以直接传 prisma 或事务客户端。 */
type RelationWriter = Pick<Prisma.TransactionClient, 'memoryRelation'>;

function relationKey(userId: string, sourceMemoryId: string, targetMemoryId: string, relationType: MemoryRelationType) {
  return { userId, sourceMemoryId, targetMemoryId, relationType };
}

/**
 * 演化边同时写一条 EVOLVES_FROM：新版本是这条关系的起点，旧版本是终点。
 * 证据就是那条 MemoryRevision，置信度 1——「用户改口」不是推断出来的。
 */
export async function recordEvolutionRelation(
  tx: RelationWriter,
  input: {
    userId: string;
    newMemoryId: string;
    previousMemoryId: string;
    revisionId: string;
  }
): Promise<void> {
  const where = relationKey(input.userId, input.newMemoryId, input.previousMemoryId, 'EVOLVES_FROM');
  await tx.memoryRelation.upsert({
    where: { userId_sourceMemoryId_targetMemoryId_relationType: where },
    create: { ...where, confidence: 1, origin: 'SYSTEM', status: 'ACTIVE', evidenceIds: [input.revisionId] },
    update: { status: 'ACTIVE', confidence: 1, origin: 'SYSTEM', evidenceIds: [input.revisionId] }
  });
}

/**
 * 巩固边（混合式记忆升级 Phase 3）：被归档的冗余旧记忆 PART_OF 保留下来的那条主记忆。
 * 方向是「旧 → 主」，表示旧条是这一主题簇的一部分、作为证据保留。置信度封顶 0.5——
 * 这是系统按主题重合做的聚类判断，不是用户亲口确认的因果，不该拿高置信度。
 */
export async function recordConsolidationRelation(
  tx: RelationWriter,
  input: { userId: string; primaryMemoryId: string; memberMemoryId: string }
): Promise<void> {
  const where = relationKey(input.userId, input.memberMemoryId, input.primaryMemoryId, 'PART_OF');
  await tx.memoryRelation.upsert({
    where: { userId_sourceMemoryId_targetMemoryId_relationType: where },
    create: { ...where, confidence: 0.5, origin: 'SYSTEM', status: 'ACTIVE', evidenceIds: [] },
    update: { status: 'ACTIVE', confidence: 0.5, origin: 'SYSTEM' }
  });
}

/**
 * 同主题边：新记忆和同一情境里已有的行做词重合。只连最像的三条，方向是「新 → 旧」。
 * 置信度 0.5 + 0.1×重合词数（上限 0.9）；没有来源消息时封顶 0.5——
 * 没有证据的边可以存在，但不该拿到高置信度。
 */
export async function recordTopicRelations(
  tx: RelationWriter,
  input: {
    userId: string;
    memoryId: string;
    content: string;
    context: MemoryContext;
    sourceMessageId: string | null;
    existing: readonly { id: string; content: string; context: MemoryContext }[];
  }
): Promise<void> {
  const tokens = new Set(topicSignature(input.content));
  if (tokens.size === 0) return;
  const normalised = input.content.replace(/\s+/g, '');
  const scored = input.existing
    .filter((row) => row.id !== input.memoryId && row.context === input.context)
    .filter((row) => row.content.replace(/\s+/g, '') !== normalised)
    .map((row) => {
      let overlap = 0;
      for (const token of topicSignature(row.content)) if (tokens.has(token)) overlap += 1;
      return { id: row.id, overlap };
    })
    .filter((row) => row.overlap >= TOPIC_OVERLAP_MIN)
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, TOPIC_RELATIONS_PER_MEMORY);

  for (const row of scored) {
    const where = relationKey(input.userId, input.memoryId, row.id, 'SAME_TOPIC');
    const confidence = input.sourceMessageId ? Math.min(0.9, 0.5 + row.overlap * 0.1) : 0.5;
    const evidenceIds = input.sourceMessageId ? [input.sourceMessageId] : [];
    await tx.memoryRelation.upsert({
      where: { userId_sourceMemoryId_targetMemoryId_relationType: where },
      create: { ...where, confidence, origin: 'SYSTEM', status: 'ACTIVE', evidenceIds },
      update: { status: 'ACTIVE', confidence, evidenceIds }
    });
  }
}

export interface RelationEdge {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  relationType: MemoryRelationType;
  confidence: number;
  origin: MemoryRelation['origin'];
}

/** 供记忆网络一屏读取：只取 ACTIVE，按置信度倒序。 */
export async function listRelationsForGraph(
  userId: string,
  memoryIds: readonly string[]
): Promise<RelationEdge[]> {
  if (memoryIds.length === 0) return [];
  const rows = await prisma.memoryRelation.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [{ sourceMemoryId: { in: [...memoryIds] } }, { targetMemoryId: { in: [...memoryIds] } }]
    },
    orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }]
  });
  return rows.map((row) => ({
    id: row.id,
    sourceMemoryId: row.sourceMemoryId,
    targetMemoryId: row.targetMemoryId,
    relationType: row.relationType,
    confidence: row.confidence,
    origin: row.origin
  }));
}

export interface RelatedMemoryHit {
  memory: MemoryDto;
  hop: number;
  relationType: MemoryRelationType;
  /** 走到这条记忆的那一步是从哪条记忆出发的。 */
  viaMemoryId: string;
  /** 出发那条的一句短引文，用来在提示词里交代「从哪儿扩过来的」。 */
  viaSnippet: string;
}

/** 关系的展示名。提示词和记忆网络共用一份，避免两处各起一套名字。 */
export const RELATION_TYPE_LABELS: Record<MemoryRelationType, string> = {
  RELATED_TO: '相关',
  SAME_TOPIC: '同主题',
  SUPPORTS: '支持',
  CONTRADICTS: '相反',
  EVOLVES_FROM: '演化自',
  PART_OF: '属于',
  OCCURRED_BEFORE: '早于',
  CAUSES_WITH_EVIDENCE: '有据因果'
};

function snippetOf(text: string, max = 18): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export interface GraphExpansionInput {
  userId: string;
  /** 关键词召回选中的种子（已经很可能是 8 条）。 */
  seeds: readonly MemoryDto[];
  /** 当前可见的记忆池；扩展目标只能从这里面出，避免把失效行捞回来。 */
  rows: readonly MemoryDto[];
  policies: Record<MemoryContext, MemoryPolicy>;
  chatId: string;
  now: Date;
  emotionEnabled?: boolean;
  emotionTransparency?: 'off' | 'implicit' | 'explicit';
}

/**
 * 从种子做最多两跳的扩展。
 *
 * 四道限制同时生效：深度 ≤2、候选节点 ≤30、最终注入 ≤8、置信度 ≥0.5。
 * 目标必须仍在可见池里、通过保留期与情境策略、且该情境允许关联——
 * 「关掉某个情境的关联」不需要删边，读侧不问它就是了。
 */
export async function expandRelatedMemories(input: GraphExpansionInput): Promise<RelatedMemoryHit[]> {
  const allowEmotion = input.emotionEnabled !== false && input.emotionTransparency !== 'off';
  const pool = new Map(input.rows.filter((row) => allowEmotion || row.type !== 'emotion').map((row) => [row.id, row]));
  const seeds = input.seeds.filter((seed) => input.policies[seed.context]?.allowAssociation === true);
  if (seeds.length === 0) return [];

  const visited = new Set(seeds.map((seed) => seed.id));
  const hits = new Map<string, RelatedMemoryHit>();
  let frontier = [...visited];
  let candidates = 0;

  for (let hop = 1; hop <= GRAPH_MAX_DEPTH && frontier.length > 0; hop += 1) {
    if (candidates >= GRAPH_MAX_NODES) break;
    const edges = await prisma.memoryRelation.findMany({
      where: {
        userId: input.userId,
        status: 'ACTIVE',
        confidence: { gte: GRAPH_MIN_CONFIDENCE },
        OR: [{ sourceMemoryId: { in: frontier } }, { targetMemoryId: { in: frontier } }]
      },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }]
    });

    const nextFrontier: string[] = [];
    for (const edge of edges) {
      if (candidates >= GRAPH_MAX_NODES) break;
      const fromSeed = frontier.includes(edge.sourceMemoryId);
      const otherId = fromSeed ? edge.targetMemoryId : edge.sourceMemoryId;
      const viaId = fromSeed ? edge.sourceMemoryId : edge.targetMemoryId;
      if (visited.has(otherId)) continue;
      const memory = pool.get(otherId);
      if (!memory) continue;
      if (input.policies[memory.context]?.allowAssociation !== true) continue;
      if (!isMemoryUsable(memory, { policies: input.policies, chatId: input.chatId, now: input.now })) continue;
      visited.add(otherId);
      nextFrontier.push(otherId);
      candidates += 1;
      hits.set(otherId, {
        memory,
        hop,
        relationType: edge.relationType,
        viaMemoryId: viaId,
        viaSnippet: snippetOf(pool.get(viaId)?.content ?? '')
      });
    }
    frontier = nextFrontier;
  }

  return [...hits.values()]
    .sort((left, right) => {
      if (left.hop !== right.hop) return left.hop - right.hop;
      const leftAt = new Date(left.memory.recordedAt).getTime();
      const rightAt = new Date(right.memory.recordedAt).getTime();
      return rightAt - leftAt;
    })
    .slice(0, GRAPH_MAX_INJECTED);
}