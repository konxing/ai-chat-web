import { prisma } from '@/lib/prisma';
// 类型住在 reflection-display 那一侧（洞察这一屏有审计过的包边界），这里以 `import type` 引用，编译期抹掉。
import type { ReflectionCooldown } from './reflection-display';

/**
 * 认知引擎的模块各自能被单个用户打开或关掉，默认全关。
 * 关掉只停读写，不删任何数据——清空数据是另一个动作。
 */
export type EmotionTransparency = 'off' | 'implicit' | 'explicit';

export interface CognitivePreferences {
  memoryEnabled: boolean;
  userModelEnabled: boolean;
  emotionEnabled: boolean;
  associationEnabled: boolean;
  timelineEnabled: boolean;
  reflectionEnabled: boolean;
  decisionMemoryEnabled: boolean;
  adaptiveMemoryEnabled: boolean;
  emotionTransparency: EmotionTransparency;
  reflectionCooldown: ReflectionCooldown;
  /**
   * 任务书 7.3 的「暂停长期记忆写入」。它故意不是第九个模块开关：
   * 模块开关管「这个模块要不要工作」，关掉后读侧也不再注入；这一列只管「还记不记新东西」，
   * 已存的记忆照常带入对话。两件事合成一件就没有「先别记、继续用旧的」这一档了。
   */
  memoryWritePaused: boolean;
}

type FlagKey = Exclude<
  keyof CognitivePreferences,
  'emotionTransparency' | 'reflectionCooldown' | 'memoryWritePaused'
>;

/** 任务书 1.1 的八个开关：前七个各对一个模块，第八个管策略学习层。 */
export const COGNITIVE_FLAGS: readonly FlagKey[] = [
  'memoryEnabled',
  'userModelEnabled',
  'emotionEnabled',
  'associationEnabled',
  'timelineEnabled',
  'reflectionEnabled',
  'decisionMemoryEnabled',
  'adaptiveMemoryEnabled'
];

/** 库里存大写枚举（Prisma 的 EmotionTransparency / ReflectionCooldown），对外一律小写。 */
type StoredRow = Omit<CognitivePreferences, 'emotionTransparency' | 'reflectionCooldown'> & {
  emotionTransparency: 'OFF' | 'IMPLICIT' | 'EXPLICIT';
  reflectionCooldown: 'DAILY' | 'WEEKLY' | 'MONTHLY';
};

const OFF: CognitivePreferences = {
  memoryEnabled: false,
  userModelEnabled: false,
  emotionEnabled: false,
  associationEnabled: false,
  timelineEnabled: false,
  reflectionEnabled: false,
  decisionMemoryEnabled: false,
  adaptiveMemoryEnabled: false,
  emotionTransparency: 'implicit',
  reflectionCooldown: 'daily',
  memoryWritePaused: false
};

const TO_STORED: Record<EmotionTransparency, StoredRow['emotionTransparency']> = {
  off: 'OFF',
  implicit: 'IMPLICIT',
  explicit: 'EXPLICIT'
};

const FROM_STORED: Record<string, EmotionTransparency> = {
  OFF: 'off',
  IMPLICIT: 'implicit',
  EXPLICIT: 'explicit'
};

const COOLDOWN_TO_STORED: Record<ReflectionCooldown, StoredRow['reflectionCooldown']> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY'
};

/**
 * 库里那一档认不出来就回落到 `daily`，不是随便挑一个默认值：`daily` 是这一列的建表默认，
 * 也就是「这条记录早于可配置冷却」的形状。回落它等于回落加这一列之前的行为。
 */
const COOLDOWN_FROM_STORED: Record<string, ReflectionCooldown> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly'
};

export type CognitivePreferencesPatch = Partial<CognitivePreferences>;

function toPreferences(row: StoredRow): CognitivePreferences {
  const preferences = {
    emotionTransparency: FROM_STORED[row.emotionTransparency] ?? 'implicit',
    reflectionCooldown: COOLDOWN_FROM_STORED[row.reflectionCooldown] ?? 'daily',
    memoryWritePaused: row.memoryWritePaused
  } as CognitivePreferences;
  for (const flag of COGNITIVE_FLAGS) preferences[flag] = row[flag];
  return preferences;
}

function toStored(patch: CognitivePreferencesPatch): Partial<StoredRow> {
  const stored: Partial<StoredRow> = {};
  for (const flag of COGNITIVE_FLAGS) {
    if (patch[flag] !== undefined) stored[flag] = patch[flag];
  }
  if (patch.emotionTransparency !== undefined) {
    stored.emotionTransparency = TO_STORED[patch.emotionTransparency];
  }
  if (patch.reflectionCooldown !== undefined) {
    stored.reflectionCooldown = COOLDOWN_TO_STORED[patch.reflectionCooldown];
  }
  if (patch.memoryWritePaused !== undefined) stored.memoryWritePaused = patch.memoryWritePaused;
  return stored;
}

export async function getCognitivePreferences(userId: string): Promise<CognitivePreferences> {
  const row = await prisma.cognitivePreference.findUnique({ where: { userId } });
  return row ? toPreferences(row as StoredRow) : { ...OFF };
}

/** update 只带用户真正改动的字段——否则改透明度会把八个开关顺手重置。 */
export async function updateCognitivePreferences(
  userId: string,
  patch: CognitivePreferencesPatch
): Promise<CognitivePreferences> {
  const changes = toStored(patch);
  if (Object.keys(changes).length === 0) return getCognitivePreferences(userId);
  const row = await prisma.cognitivePreference.upsert({
    where: { userId },
    create: { userId, ...toStored(OFF), ...changes },
    update: changes
  });
  return toPreferences(row as StoredRow);
}
