import { prisma } from '@/lib/prisma';

/**
 * 认知引擎的三个模块各自能被单个用户打开或关掉，默认全关。
 * 关掉只停读写，不删任何数据——清空数据是另一个动作。
 */
export type EmotionTransparency = 'off' | 'implicit' | 'explicit';

export interface CognitivePreferences {
  memoryEnabled: boolean;
  profileEnabled: boolean;
  emotionEnabled: boolean;
  emotionTransparency: EmotionTransparency;
}

/** 库里存大写枚举，对外一律小写：接口和前端不需要知道 Prisma 的枚举命名。 */
type StoredRow = Omit<CognitivePreferences, 'emotionTransparency'> & {
  emotionTransparency: 'OFF' | 'IMPLICIT' | 'EXPLICIT';
};

const OFF: CognitivePreferences = {
  memoryEnabled: false,
  profileEnabled: false,
  emotionEnabled: false,
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
  return {
    memoryEnabled: row.memoryEnabled,
    profileEnabled: row.profileEnabled,
    emotionEnabled: row.emotionEnabled,
    emotionTransparency: FROM_STORED[row.emotionTransparency] ?? 'implicit'
  };
}

function toStored(patch: CognitivePreferencesPatch): Partial<StoredRow> {
  const stored: Partial<StoredRow> = {};
  if (patch.memoryEnabled !== undefined) stored.memoryEnabled = patch.memoryEnabled;
  if (patch.profileEnabled !== undefined) stored.profileEnabled = patch.profileEnabled;
  if (patch.emotionEnabled !== undefined) stored.emotionEnabled = patch.emotionEnabled;
  if (patch.emotionTransparency !== undefined) {
    stored.emotionTransparency = TO_STORED[patch.emotionTransparency];
  }
  return stored;
}

export async function getCognitivePreferences(userId: string): Promise<CognitivePreferences> {
  const row = await prisma.cognitivePreference.findUnique({ where: { userId } });
  return row ? toPreferences(row as StoredRow) : { ...OFF };
}

/** update 只带用户真正改动的字段——否则改透明度会把另外三个开关顺手重置。 */
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
