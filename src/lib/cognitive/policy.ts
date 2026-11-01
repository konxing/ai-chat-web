import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';

/**
 * 自适应记忆策略（任务书 1.2）。核心立场：系统无条件记住一切是错的，
 * 所以每种情境都要能单独回答「允许持久化吗、允许记哪些类型、留多久、要不要先问」。
 * 这里的内置默认必须和迁移文件里那张表的默认值一样保守——库里没配过行的用户走的就是它。
 *
 * 情境、类型、保留策略都以「对外小写驼峰 / 入库大写枚举」成对定义：
 * 前端和接口不需要知道 Prisma 的枚举命名，写库和读库各转一次。
 */
const CONTEXT_PAIRS = [
  ['general', 'GENERAL'],
  ['technicalProject', 'TECHNICAL_PROJECT'],
  ['learning', 'LEARNING'],
  ['personalGoal', 'PERSONAL_GOAL'],
  ['personalReflection', 'PERSONAL_REFLECTION'],
  ['emotionalSupport', 'EMOTIONAL_SUPPORT'],
  ['decisionMaking', 'DECISION_MAKING']
] as const;

const TYPE_PAIRS = [
  ['fact', 'FACT'],
  ['preference', 'PREFERENCE'],
  ['goal', 'GOAL'],
  ['project', 'PROJECT'],
  ['decision', 'DECISION'],
  ['emotion', 'EMOTION']
] as const;

const RETENTION_PAIRS = [
  ['forever', 'FOREVER'],
  ['untilSuperseded', 'UNTIL_SUPERSEDED'],
  ['days30', 'DAYS_30'],
  ['days90', 'DAYS_90'],
  ['sessionOnly', 'SESSION_ONLY']
] as const;

export type MemoryContext = (typeof CONTEXT_PAIRS)[number][0];
export type MemoryType = (typeof TYPE_PAIRS)[number][0];
export type MemoryRetention = (typeof RETENTION_PAIRS)[number][0];

type DbContext = (typeof CONTEXT_PAIRS)[number][1];
type DbMemoryType = (typeof TYPE_PAIRS)[number][1];
type DbRetention = (typeof RETENTION_PAIRS)[number][1];

export interface MemoryPolicy {
  context: MemoryContext;
  allowPersistence: boolean;
  allowedMemoryTypes: MemoryType[];
  requireConfirmation: boolean;
  retention: MemoryRetention;
  allowUserProfile: boolean;
  allowReflection: boolean;
  allowAssociation: boolean;
}

export type MemoryPolicyPatch = Partial<Omit<MemoryPolicy, 'context'>>;

interface StoredRow {
  userId: string;
  context: DbContext;
  allowPersistence: boolean;
  allowedMemoryTypes: DbMemoryType[];
  requireConfirmation: boolean;
  retention: DbRetention;
  allowUserProfile: boolean;
  allowReflection: boolean;
  allowAssociation: boolean;
}

export const MEMORY_CONTEXTS: readonly MemoryContext[] = CONTEXT_PAIRS.map(([app]) => app);
export const MEMORY_TYPES: readonly MemoryType[] = TYPE_PAIRS.map(([app]) => app);
export const MEMORY_RETENTIONS: readonly MemoryRetention[] = RETENTION_PAIRS.map(([app]) => app);

function toDb<K extends string, V extends string>(
  pairs: ReadonlyArray<readonly [K, V]>,
  value: K,
  field: string,
  allowed: readonly K[]
): V {
  const match = pairs.find((pair) => pair[0] === value);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 只能是 ${allowed.join('、')} 之一`);
  return match[1];
}

/** 读到的枚举值不在成对表里＝库里写着应用不认识的东西，属于数据异常而不是用户输入错误。 */
function fromDb<K extends string, V extends string>(
  pairs: ReadonlyArray<readonly [K, V]>,
  value: V,
  field: string
): K {
  const match = pairs.find((pair) => pair[1] === value);
  if (!match) throw new ApiError(500, 'STORAGE_ERROR', `数据库里的${field}取值异常`);
  return match[0];
}

/**
 * 两个敏感情境连「允许记哪些类型」里都不放 emotion：情绪内容默认只活在当前会话，
 * 用户即使打开了持久化也要另外显式加上类型，不被顺手带进长期库。
 */
const sensitiveDefaults = (): Omit<MemoryPolicy, 'context'> => ({
  allowPersistence: false,
  allowedMemoryTypes: ['fact', 'goal'],
  requireConfirmation: false,
  retention: 'sessionOnly',
  allowUserProfile: false,
  allowReflection: false,
  allowAssociation: false
});

export const DEFAULT_MEMORY_POLICIES: Record<MemoryContext, MemoryPolicy> = {
  general: {
    context: 'general',
    allowPersistence: true,
    allowedMemoryTypes: ['fact', 'preference', 'goal', 'project', 'decision'],
    requireConfirmation: false,
    retention: 'forever',
    allowUserProfile: true,
    allowReflection: true,
    allowAssociation: true
  },
  technicalProject: {
    context: 'technicalProject',
    allowPersistence: true,
    allowedMemoryTypes: ['fact', 'preference', 'goal', 'project', 'decision'],
    requireConfirmation: false,
    retention: 'forever',
    allowUserProfile: true,
    allowReflection: true,
    allowAssociation: true
  },
  learning: {
    context: 'learning',
    allowPersistence: true,
    allowedMemoryTypes: ['fact', 'preference', 'goal', 'project'],
    requireConfirmation: false,
    retention: 'forever',
    allowUserProfile: true,
    allowReflection: true,
    allowAssociation: true
  },
  personalGoal: {
    context: 'personalGoal',
    allowPersistence: true,
    allowedMemoryTypes: ['goal', 'fact', 'preference', 'decision'],
    requireConfirmation: false,
    retention: 'forever',
    allowUserProfile: true,
    allowReflection: true,
    allowAssociation: true
  },
  personalReflection: { context: 'personalReflection', ...sensitiveDefaults() },
  emotionalSupport: { context: 'emotionalSupport', ...sensitiveDefaults() },
  decisionMaking: {
    context: 'decisionMaking',
    allowPersistence: true,
    allowedMemoryTypes: ['decision', 'fact', 'goal'],
    // 正式决策记录必须用户确认过才存在（任务书 5.1），不能由系统代记。
    requireConfirmation: true,
    retention: 'forever',
    allowUserProfile: false,
    allowReflection: true,
    allowAssociation: true
  }
};

function toStored(policy: MemoryPolicy): Omit<StoredRow, 'userId'> {
  return {
    context: toDb(CONTEXT_PAIRS, policy.context, '情境', MEMORY_CONTEXTS),
    allowPersistence: policy.allowPersistence,
    allowedMemoryTypes: policy.allowedMemoryTypes.map((type) =>
      toDb(TYPE_PAIRS, type, '记忆类型', MEMORY_TYPES)
    ),
    requireConfirmation: policy.requireConfirmation,
    retention: toDb(RETENTION_PAIRS, policy.retention, '保留策略', MEMORY_RETENTIONS),
    allowUserProfile: policy.allowUserProfile,
    allowReflection: policy.allowReflection,
    allowAssociation: policy.allowAssociation
  };
}

/** 只搬运用户真正改动的字段，其余保持原值——否则改一个开关会把同一行的别的设置顺手重置。 */
function toStoredPatch(patch: MemoryPolicyPatch): Partial<Omit<StoredRow, 'userId' | 'context'>> {
  const stored: Partial<Omit<StoredRow, 'userId' | 'context'>> = {};
  if (patch.allowPersistence !== undefined) stored.allowPersistence = patch.allowPersistence;
  if (patch.requireConfirmation !== undefined) stored.requireConfirmation = patch.requireConfirmation;
  if (patch.allowUserProfile !== undefined) stored.allowUserProfile = patch.allowUserProfile;
  if (patch.allowReflection !== undefined) stored.allowReflection = patch.allowReflection;
  if (patch.allowAssociation !== undefined) stored.allowAssociation = patch.allowAssociation;
  if (patch.retention !== undefined) {
    stored.retention = toDb(RETENTION_PAIRS, patch.retention, '保留策略', MEMORY_RETENTIONS);
  }
  if (patch.allowedMemoryTypes !== undefined) {
    stored.allowedMemoryTypes = patch.allowedMemoryTypes.map((type) =>
      toDb(TYPE_PAIRS, type, '记忆类型', MEMORY_TYPES)
    );
  }
  return stored;
}

function toPolicy(row: StoredRow): MemoryPolicy {
  return {
    context: fromDb(CONTEXT_PAIRS, row.context, '记忆情境'),
    allowPersistence: row.allowPersistence,
    allowedMemoryTypes: row.allowedMemoryTypes.map((type) => fromDb(TYPE_PAIRS, type, '记忆类型')),
    requireConfirmation: row.requireConfirmation,
    retention: fromDb(RETENTION_PAIRS, row.retention, '保留策略'),
    allowUserProfile: row.allowUserProfile,
    allowReflection: row.allowReflection,
    allowAssociation: row.allowAssociation
  };
}

/** 一次查询取回该用户的全部策略行，库里没有的情境用内置默认补齐。 */
export async function getMemoryPolicies(userId: string): Promise<Record<MemoryContext, MemoryPolicy>> {
  const rows = (await prisma.memoryPolicy.findMany({ where: { userId } })) as unknown as StoredRow[];
  const stored = new Map(rows.map((row) => [row.context, row]));
  const policies = {} as Record<MemoryContext, MemoryPolicy>;
  for (const context of MEMORY_CONTEXTS) {
    const row = stored.get(toDb(CONTEXT_PAIRS, context, '情境', MEMORY_CONTEXTS));
    policies[context] = row ? toPolicy(row) : { ...DEFAULT_MEMORY_POLICIES[context] };
  }
  return policies;
}

export async function getMemoryPolicy(userId: string, context: MemoryContext): Promise<MemoryPolicy> {
  return (await getMemoryPolicies(userId))[context];
}

/** 没配过的情境以内置默认为底再叠用户的补丁；补丁里的非法取值在落库前就被拒。 */
export async function updateMemoryPolicy(
  userId: string,
  context: MemoryContext,
  patch: MemoryPolicyPatch
): Promise<MemoryPolicy> {
  const dbContext = toDb(CONTEXT_PAIRS, context, '情境', MEMORY_CONTEXTS);
  const row = await prisma.memoryPolicy.upsert({
    where: { userId_context: { userId, context: dbContext } },
    create: { userId, ...toStored({ ...DEFAULT_MEMORY_POLICIES[context], ...patch, context }) },
    update: toStoredPatch(patch)
  });
  return toPolicy(row as unknown as StoredRow);
}

/** 重置＝删掉用户那一行，回到内置默认。跟「关掉模块」不是一回事。 */
export async function resetMemoryPolicy(userId: string, context: MemoryContext): Promise<MemoryPolicy> {
  await prisma.memoryPolicy.deleteMany({
    where: { userId, context: toDb(CONTEXT_PAIRS, context, '情境', MEMORY_CONTEXTS) }
  });
  return { ...DEFAULT_MEMORY_POLICIES[context] };
}
