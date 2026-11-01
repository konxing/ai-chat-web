import { log } from '@/lib/logger';
import { getCognitivePreferences, type CognitivePreferences } from './preferences';

export type CognitiveModuleKey = 'memory' | 'profile' | 'emotion';

/** 一次对话轮次里模块能拿到的全部上下文——只给 id 和正文，不给别人的数据。 */
export interface CognitiveTurn {
  userId: string;
  chatId: string;
  content: string;
}

/** 模块产出的一段可注入提示词的文本。label 是给前端分组用的中文名。 */
export interface CognitiveBlock {
  module: CognitiveModuleKey;
  label: string;
  text: string;
}

export interface CognitiveModule {
  key: CognitiveModuleKey;
  read: (turn: CognitiveTurn) => Promise<CognitiveBlock[]>;
  write?: (turn: CognitiveTurn) => Promise<void>;
}

/**
 * 认知引擎挂在主聊天链路上：读侧在发问之前，卡住就等于整条对话变慢，
 * 所以给每个模块一个硬截止。写侧在回答之后，同一个数值够用了。
 */
export const COGNITIVE_MODULE_DEADLINE_MS = 1000;

const SWITCH: Record<CognitiveModuleKey, keyof CognitivePreferences> = {
  memory: 'memoryEnabled',
  profile: 'profileEnabled',
  emotion: 'emotionEnabled'
};

const registry = new Map<CognitiveModuleKey, CognitiveModule>();

export function registerCognitiveModule(module: CognitiveModule): void {
  registry.set(module.key, module);
}

export interface CognitiveReadResult {
  blocks: CognitiveBlock[];
  failed: CognitiveModuleKey[];
}

export async function runCognitiveReads(turn: CognitiveTurn): Promise<CognitiveReadResult> {
  const enabled = await enabledModules(turn.userId);
  const blocks: CognitiveBlock[] = [];
  const failed: CognitiveModuleKey[] = [];
  for (const outcome of await settleAll(enabled, (module) => module.read(turn))) {
    if (outcome.status === 'ok') blocks.push(...outcome.value);
    else {
      failed.push(outcome.module.key);
      // 只记模块、用户和失败类型：模块的报错原文里常常带着记忆正文或密钥片段。
      log.warn('cognitive.read_failed', { module: outcome.module.key, userId: turn.userId, reason: outcome.reason });
    }
  }
  return { blocks, failed };
}

export interface CognitiveWriteResult {
  failed: CognitiveModuleKey[];
}

export async function runCognitiveWrites(turn: CognitiveTurn): Promise<CognitiveWriteResult> {
  const enabled = (await enabledModules(turn.userId)).filter((module) => module.write);
  const failed: CognitiveModuleKey[] = [];
  for (const outcome of await settleAll(enabled, (module) => module.write!(turn))) {
    if (outcome.status !== 'ok') {
      failed.push(outcome.module.key);
      log.warn('cognitive.write_failed', { module: outcome.module.key, userId: turn.userId, reason: outcome.reason });
    }
  }
  return { failed };
}

/** 开关读不出来就当全关——认知引擎宁可什么都不做，也不能把对话带下水。 */
async function enabledModules(userId: string): Promise<CognitiveModule[]> {
  let preferences: CognitivePreferences;
  try {
    preferences = await getCognitivePreferences(userId);
  } catch {
    log.warn('cognitive.preferences_unavailable', { userId });
    return [];
  }
  return [...registry.values()].filter((module) => preferences[SWITCH[module.key]] === true);
}

type Outcome<T> =
  | { status: 'ok'; module: CognitiveModule; value: T }
  | { status: 'failed'; module: CognitiveModule; reason: 'error' | 'timeout' };

function settleAll<T>(
  modules: CognitiveModule[],
  run: (module: CognitiveModule) => Promise<T>
): Promise<Array<Outcome<T>>> {
  return Promise.all(modules.map((module) => settle(module, run(module))));
}

async function settle<T>(module: CognitiveModule, task: Promise<T>): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), COGNITIVE_MODULE_DEADLINE_MS);
  });
  // 先挂上 rejection 处理器，模块失败后再没人 await 会变成 unhandledRejection。
  const settled = task.then(
    (value) => ({ status: 'ok' as const, value }),
    () => ({ status: 'failed' as const, reason: 'error' as const })
  );
  try {
    const result = await Promise.race([settled, deadline]);
    if (result === 'timeout') return { status: 'failed', module, reason: 'timeout' };
    return result.status === 'ok'
      ? { status: 'ok', module, value: result.value }
      : { status: 'failed', module, reason: result.reason };
  } finally {
    clearTimeout(timer);
  }
}
