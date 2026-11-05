import { classifyContext } from '@/lib/cognitive/context-classifier';
import { normalizeForMatch } from '@/lib/cognitive/normalize';
import {
  MEMORY_CONTEXTS,
  type MemoryContext,
  type MemoryPolicy,
  type MemoryRetention,
  type MemoryType
} from '@/lib/cognitive/policy';

/**
 * 写入决策（任务书 1.2）：把情境分类的结果和该情境的策略合成一个动作。
 *
 * 输入：候选记忆的类型、原文（只用于词法分类，不进输出）、长期记忆总开关、七情境策略表，
 * 以及调用方用 findNearDuplicate 查出来的「这条在说同一件事的旧记忆」。
 * 输出：动作 + 采纳的情境 + 保留期 + 三个下游许可；不含原文任何片段。
 * 测试：tests/unit/cognitive-write-decision.test.ts
 *
 * LINK 和 DELETE 都没有分支，而且这两个缺口是**关掉的**，不是待建：
 * 关系全部从库里已经存在的行推导（2a 那次阈值校准判的就是不建关系表），所以「建立关联」永远不会
 * 成为一个由词法猜出来的写入动作；DELETE 是用户点出来的动作，三种忘记（纠正/归档/永久删除）各有自己的
 * 入口和路由，不在这一层。这一层只决定「这条候选要不要落库、以什么身份落库」。
 */
export type MemoryWriteAction = 'WRITE' | 'UPDATE' | 'EPHEMERAL' | 'ASK_CONFIRM' | 'IGNORE';

export type MemoryWriteReason =
  | 'module_off'
  | 'type_not_allowed'
  | 'no_persistence'
  | 'needs_confirmation'
  | 'supersedes_existing'
  | 'allowed';

export interface MemoryWriteInput {
  memoryEnabled: boolean;
  memoryType: MemoryType;
  text: string;
  policies: Record<MemoryContext, MemoryPolicy>;
  /** 调用方查出来的「同一件事的旧记忆」；没有就留空，绝不自己猜。 */
  supersedeId?: string | null;
}

export interface MemoryWritePlan {
  decision: MemoryWriteAction;
  reason: MemoryWriteReason;
  context: MemoryContext;
  ambiguous: boolean;
  retention: MemoryRetention;
  allowUserProfile: boolean;
  allowAssociation: boolean;
  allowReflection: boolean;
  /** 只有 UPDATE 才带；其它动作一律 null，免得下游拿一个没被采纳的 id 去改历史。 */
  supersedeId: string | null;
}

/** 保留期由短到长——越短越保守。索引写死，不依赖成对表的顺序。 */
const RETENTION_RANK: Record<MemoryRetention, number> = {
  sessionOnly: 0,
  days30: 1,
  days90: 2,
  untilSuperseded: 3,
  forever: 4
};

/**
 * 保守度按四个问题逐层比较，越小说明越不留东西：
 * 能不能落库 → 落库前要不要先问 → 允许记的类型有几个 → 留下的能留多久。
 */
function conservatism(policy: MemoryPolicy): [number, number, number, number] {
  return [
    policy.allowPersistence ? 1 : 0,
    policy.requireConfirmation ? 0 : 1,
    policy.allowedMemoryTypes.length,
    RETENTION_RANK[policy.retention]
  ];
}

function isMoreConservative(candidate: MemoryPolicy, current: MemoryPolicy): boolean {
  const left = conservatism(candidate);
  const right = conservatism(current);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

/** 情境信号打架时，不允许挑一个对系统最有利的解释——取候选里最保守的那条策略。 */
export function mostConservativePolicy(
  candidates: readonly MemoryContext[],
  policies: Record<MemoryContext, MemoryPolicy>
): MemoryPolicy {
  let best: MemoryPolicy | undefined;
  for (const context of MEMORY_CONTEXTS) {
    if (!candidates.includes(context)) continue;
    const policy = policies[context];
    if (!best || isMoreConservative(policy, best)) best = policy;
  }
  if (!best) throw new RangeError('mostConservativePolicy 收到空候选');
  return best;
}

function notRetained(
  decision: MemoryWriteAction,
  reason: MemoryWriteReason,
  context: MemoryContext,
  ambiguous: boolean
): MemoryWritePlan {
  // 没进长期库的内容（或还没得到确认的内容）不得反过来喂画像、反思和关联。
  return {
    decision,
    reason,
    context,
    ambiguous,
    retention: 'sessionOnly',
    allowUserProfile: false,
    allowAssociation: false,
    allowReflection: false,
    supersedeId: null
  };
}

export function planMemoryWrite(input: MemoryWriteInput): MemoryWritePlan {
  const { winner, ambiguous, candidates } = classifyContext(input.text);
  if (!input.memoryEnabled) return notRetained('EPHEMERAL', 'module_off', winner, ambiguous);

  const context = ambiguous ? mostConservativePolicy(candidates, input.policies).context : winner;
  const policy = input.policies[context];
  if (!policy.allowedMemoryTypes.includes(input.memoryType)) {
    return notRetained('IGNORE', 'type_not_allowed', context, ambiguous);
  }
  if (!policy.allowPersistence) return notRetained('EPHEMERAL', 'no_persistence', context, ambiguous);
  if (policy.requireConfirmation) return notRetained('ASK_CONFIRM', 'needs_confirmation', context, ambiguous);

  // 走到这里才轮到取代：上面四道关卡没过，就不许动已有记忆的历史。
  const supersedes = Boolean(input.supersedeId);
  return {
    decision: supersedes ? 'UPDATE' : 'WRITE',
    reason: supersedes ? 'supersedes_existing' : 'allowed',
    context,
    ambiguous,
    retention: policy.retention,
    allowUserProfile: policy.allowUserProfile,
    allowAssociation: policy.allowAssociation,
    allowReflection: policy.allowReflection,
    supersedeId: supersedes ? (input.supersedeId ?? null) : null
  };
}

/** 「近乎同句」的两道门槛：长度差得远的根本不比，相似度不够就并存。 */
const NEAR_DUPLICATE_MIN_SIMILARITY = 0.8;
const NEAR_DUPLICATE_MIN_LENGTH_RATIO = 0.6;

export interface NearDuplicateRow {
  id: string;
  type: MemoryType;
  content: string;
}

function bigrams(text: string): string[] {
  if (text.length < 2) return [text];
  const grams: string[] = [];
  for (let index = 0; index < text.length - 1; index += 1) grams.push(text.slice(index, index + 2));
  return grams;
}

function bigramSimilarity(left: string, right: string): number {
  const a = new Set(bigrams(left));
  const b = new Set(bigrams(right));
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * 找「同一件事的新说法」。只跟同类型的行比，命中就返回第一条——调用方按 recordedAt 倒序给，
 * 所以那是最近的一次说法。完全同句返回 null：那句该由调用方跳过，不该消耗一次演化。
 *
 * 阈值 0.8 是刻意压高的：短句里换一个词占比就过半，那种情况宁可让两条并存
 * （「我住北京」和「我住上海」不会自动取代），误删一条真记忆比多留一条脏数据贵。
 * 输入输出都不带正文，返回值只有一个 id。
 */
export function findNearDuplicate(
  candidate: { text: string; type: MemoryType },
  existing: readonly NearDuplicateRow[]
): string | null {
  const text = normalizeForMatch(candidate.text);
  if (text.length < 2) return null;
  for (const row of existing) {
    if (row.type !== candidate.type) continue;
    const previous = normalizeForMatch(row.content);
    if (previous === text) continue;
    const ratio = Math.min(text.length, previous.length) / Math.max(text.length, previous.length);
    if (ratio < NEAR_DUPLICATE_MIN_LENGTH_RATIO) continue;
    if (bigramSimilarity(text, previous) >= NEAR_DUPLICATE_MIN_SIMILARITY) return row.id;
  }
  return null;
}
