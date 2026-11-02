import { classifyContext } from '@/lib/cognitive/context-classifier';
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
 * 输入：候选记忆的类型、原文（只用于词法分类，不进输出）、长期记忆总开关、七情境策略表。
 * 输出：动作 + 采纳的情境 + 保留期 + 三个下游许可；不含原文任何片段。
 * 测试：tests/unit/cognitive-write-decision.test.ts
 *
 * 这一版只有 WRITE / EPHEMERAL / ASK_CONFIRM / IGNORE 四个动作。
 * UPDATE、LINK、DELETE 需要拿已有记忆行做比对，那是 Phase 2 记忆表落地之后的事，
 * 这里不放假分支凑齐七个。
 */
export type MemoryWriteAction = 'WRITE' | 'EPHEMERAL' | 'ASK_CONFIRM' | 'IGNORE';

export type MemoryWriteReason =
  | 'module_off'
  | 'type_not_allowed'
  | 'no_persistence'
  | 'needs_confirmation'
  | 'allowed';

export interface MemoryWriteInput {
  memoryEnabled: boolean;
  memoryType: MemoryType;
  text: string;
  policies: Record<MemoryContext, MemoryPolicy>;
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
    allowReflection: false
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

  return {
    decision: 'WRITE',
    reason: 'allowed',
    context,
    ambiguous,
    retention: policy.retention,
    allowUserProfile: policy.allowUserProfile,
    allowAssociation: policy.allowAssociation,
    allowReflection: policy.allowReflection
  };
}
