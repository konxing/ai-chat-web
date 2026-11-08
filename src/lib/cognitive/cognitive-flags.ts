import { getRawSystemSetting } from '@/lib/config';

/**
 * 认知层实验功能的合并开关（后台「系统配置」两个开关，环境变量兜底）。
 *
 * 用户要求把零散的 env 开关合并成「一两个」界面开关。这里把六个 env 旗标归成两组：
 * - 检索与整理增强（cognitiveRetrievalEnhanced，默认关）：严格相关性检索 / 混合语义检索 /
 *   衰减排序 / 记忆巩固。后台一旦配置，四个一起跟随；没配置时各自回落原来的 env（老部署不变）。
 * - 上下文增强（cognitiveContextEnhanced，默认开）：记忆溯源展开 / 能力观察注入。
 *   没配置时溯源展开保持开（它是已验证的核心功能）、能力观察回落 env（opt-in）；
 *   配置后两者一起跟随。能力观察本身还要求用户在能力面板启用维度，所以默认开也安全。
 *
 * 读取顺序与现有开关一致：后台配置优先，环境变量兜底。
 */

function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

async function bundleOrEnv(settingKey: string, envName: string, fallback: boolean): Promise<boolean> {
  const raw = await getRawSystemSetting(settingKey).catch(() => null);
  if (raw !== null) return asBool(raw);
  const env = process.env[envName];
  if (env !== undefined) return env === '1';
  return fallback;
}

/** 严格相关性检索：无命中不再拿最近的无关记忆补位。 */
export function strictRelevanceEnabled(): Promise<boolean> {
  return bundleOrEnv('cognitiveRetrievalEnhanced', 'COGNITIVE_RETRIEVAL_V2', false);
}

/** 混合语义检索（向量臂）。调用方仍会再要求 strictRelevance 同开。 */
export function hybridRetrievalEnabled(): Promise<boolean> {
  return bundleOrEnv('cognitiveRetrievalEnhanced', 'COGNITIVE_HYBRID_RETRIEVAL', false);
}

/** 衰减排序 tie-break。 */
export function decayRankingEnabled(): Promise<boolean> {
  return bundleOrEnv('cognitiveRetrievalEnhanced', 'COGNITIVE_MEMORY_DECAY', false);
}

/** 记忆巩固（同义冗余归档）。 */
export function consolidationEnabled(): Promise<boolean> {
  return bundleOrEnv('cognitiveRetrievalEnhanced', 'COGNITIVE_MEMORY_CONSOLIDATION', false);
}

/** 记忆溯源展开：默认开，保住已验证的核心功能。 */
export function sourceDiveEnabled(): Promise<boolean> {
  return bundleOrEnv('cognitiveContextEnhanced', 'COGNITIVE_SOURCE_DIVE', true);
}

/** 能力观察注入：没配置时回落 env（opt-in）；配置后跟随合并开关。 */
export function capabilityContextEnabled(): Promise<boolean> {
  return bundleOrEnv('cognitiveContextEnhanced', 'COGNITIVE_CAPABILITY_CONTEXT', false);
}

/** 对话智能层总开关：默认关，保住现有聊天契约；后台/ env 打开后才注入交流原则块。 */
export function conversationLayerEnabled(): Promise<boolean> {
  return bundleOrEnv('conversationLayerEnabled', 'COGNITIVE_CONVERSATION_LAYER', false);
}

/**
 * P4：对话引擎两臂灰度。默认 legacy；全局 conversationEngineVersion 可设 dialogue-v2；
 * 按用户键 conversationEngineVersionUser:<userId> 可单独覆盖（小范围灰度），遵守现有权限模型。
 */
export async function conversationEngineVersionFor(userId: string): Promise<'legacy' | 'dialogue-v2'> {
  const perUser = await getRawSystemSetting(`conversationEngineVersionUser:${userId}`).catch(() => null);
  if (perUser === 'legacy' || perUser === 'dialogue-v2') return perUser;
  const global = await getRawSystemSetting('conversationEngineVersion').catch(() => null);
  return global === 'dialogue-v2' ? 'dialogue-v2' : 'legacy';
}
