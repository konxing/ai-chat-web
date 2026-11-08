import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { archiveMemory, listMemories, type MemoryDto } from './memories';
import { normalizeForMatch } from './normalize';
import { recordConsolidationRelation } from './relations';
import { consolidationEnabled } from './cognitive-flags';

/**
 * 记忆巩固（混合式记忆升级 Phase 3，借鉴 LangMem 的后台 consolidation）。
 *
 * 做的事：把同类型、同情境、主题高度重合的冗余记忆聚成簇，保留最新一条为活跃主记忆，
 * 其余**可逆归档**并用 PART_OF 边连到主记忆作为证据。不删除、不覆盖原文——归档可恢复，
 * 原始记忆正文与来源全留着（任务书 5.4「综合摘要不得替代原始证据」）。
 *
 * 三条安全边界：
 * 一、**只在同 type + 同 context 内聚**。不同项目、不同情境的技术经历绝不合并（任务书 5.3 红线）。
 * 二、**阈值压高（0.85）**。只并几乎同义的重复，「我住北京」和「我住上海」这种换值的不会被并。
 * 三、**默认关**（env `COGNITIVE_MEMORY_CONSOLIDATION=1`），跑在后台 worker，不阻塞对话。
 *
 * 这一版不做 LLM 综合摘要（那会引入推断与成本）：主记忆就是用户最近一次说法，旧条归档为证据。
 * 测试：tests/unit/cognitive-memory-consolidator.test.ts
 */

/** 主题重合到此值才算冗余重复；低于它宁可并存，误并一条真记忆比多留一条贵。 */
export const CONSOLIDATION_SIMILARITY_THRESHOLD = 0.85;

export function memoryConsolidationEnabled(): boolean {
  return process.env.COGNITIVE_MEMORY_CONSOLIDATION === '1';
}

function bigrams(text: string): Set<string> {
  if (text.length < 2) return new Set([text]);
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

function similarity(left: string, right: string): number {
  const a = bigrams(normalizeForMatch(left));
  const b = bigrams(normalizeForMatch(right));
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * 纯函数聚类：同 type+context 一桶，桶内按记录时间倒序，贪心地把与主记忆足够像的归到一簇。
 * 只返回成员 ≥2 的簇，主记忆（最新）排第一。不碰数据库。
 */
export function findConsolidationGroups(memories: readonly MemoryDto[]): MemoryDto[][] {
  const buckets = new Map<string, MemoryDto[]>();
  for (const memory of memories) {
    const key = `${memory.type}|${memory.context}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(memory);
    buckets.set(key, bucket);
  }
  const groups: MemoryDto[][] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
    const used = new Set<string>();
    for (const primary of sorted) {
      if (used.has(primary.id)) continue;
      const group = [primary];
      used.add(primary.id);
      for (const candidate of sorted) {
        if (used.has(candidate.id)) continue;
        if (similarity(primary.content, candidate.content) >= CONSOLIDATION_SIMILARITY_THRESHOLD) {
          group.push(candidate);
          used.add(candidate.id);
        }
      }
      if (group.length >= 2) groups.push(group);
    }
  }
  return groups;
}

export interface ConsolidationOutcome {
  groups: number;
  archived: number;
}

/** 后台跑一轮巩固。关着时一个库都不读；任何一步失败只记 id，不抛给 worker。 */
export async function runMemoryConsolidation(userId: string): Promise<ConsolidationOutcome> {
  if (!(await consolidationEnabled())) return { groups: 0, archived: 0 };
  const outcome: ConsolidationOutcome = { groups: 0, archived: 0 };
  try {
    const memories = await listMemories(userId);
    const groups = findConsolidationGroups(memories);
    for (const group of groups) {
      const primary = group[0];
      for (const member of group.slice(1)) {
        await recordConsolidationRelation(prisma, {
          userId,
          primaryMemoryId: primary.id,
          memberMemoryId: member.id
        });
        await archiveMemory(member.id, userId);
        outcome.archived += 1;
      }
      outcome.groups += 1;
    }
  } catch {
    log.warn('cognitive.consolidation_failed', { userId });
  }
  return outcome;
}