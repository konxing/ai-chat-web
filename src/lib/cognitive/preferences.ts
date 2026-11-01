import { prisma } from '@/lib/prisma';

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
}

type FlagKey = Exclude<keyof CognitivePreferences, 'emotionTransparency'>;

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

/** 库里存大写枚举（Prisma 的 EmotionTransparency），对外一律小写。 */
type StoredRow = Omit<CognitivePreferences, 'emotionTransparency'> & {
  emotionTransparency: 'OFF' | 'IMPLICIT' | 'EXPLICIT';
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
  emotionTransparency: 'implicit'
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

export type CognitivePreferencesPatch = Partial<CognitivePreferences>;

function toPreferences(row: StoredRow): CognitivePreferences {
  const preferences = {
    emotionTransparency: FROM_STORED[row.emotionTransparency] ?? 'implicit'
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
