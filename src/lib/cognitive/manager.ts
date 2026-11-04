import { log } from '@/lib/logger';
import { getCognitivePreferences, type CognitivePreferences } from './preferences';

export type CognitiveModuleKey =
  | 'memory'
  | 'userModel'
  | 'emotion'
  | 'association'
  | 'timeline'
  | 'reflection'
  | 'decisionMemory';

/** 一次对话轮次里模块能拿到的全部上下文——只给 id 和正文，不给别人的数据。 */
export interface CognitiveTurn {
  userId: string;
  chatId: string;
  content: string;
  /** 这一轮的用户消息 id：记忆要能追溯到是哪句话产生的（任务书 3.6）。 */
  sourceMessageId?: string;
  /** 用户说话的时刻，比「服务器现在处理到这一条」更接近事实发生的时间。 */
  occurredAt?: Date;
}

/** 模块产出的一段可注入提示词的文本。label 是给前端分组用的中文名。 */
export interface CognitiveBlock {
  module: CognitiveModuleKey;
  label: string;
  text: string;
  /**
   * 这一块真正带进提示词的记忆 id（任务书 8.2 的引用提示据此说话）。
   * 只有真的产出了记忆块的模块填它；填的必须是**进了 text 的那几条**，
   * 被字符预算截掉的不在这里——否则界面会报出模型根本没读到的东西。
   */
  memoryIds?: readonly string[];
}

export interface CognitiveModule {
  key: CognitiveModuleKey;
  read: (turn: CognitiveTurn) => Promise<CognitiveBlock[]>;
  write?: (turn: CognitiveTurn) => Promise<void>;
}

/**
 * 认知引擎挂在主聊天链路上：读侧在发问之前，卡住就等于整条对话变慢，
 * 所以给每个模块一个硬截止。写侧由后台 worker 跑，等得起，截止由调用方给。
 */
export const COGNITIVE_MODULE_DEADLINE_MS = 1000;

/** 模块键 → 用户偏好上的那个开关。worker 判断「这条欠账还要不要跑」用的也是这张表。 */
export const MODULE_SWITCH: Record<CognitiveModuleKey, keyof CognitivePreferences> = {
  memory: 'memoryEnabled',
  userModel: 'userModelEnabled',
  emotion: 'emotionEnabled',
  association: 'associationEnabled',
  timeline: 'timelineEnabled',
  reflection: 'reflectionEnabled',
  decisionMemory: 'decisionMemoryEnabled'
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
  for (const outcome of await settleAll(enabled, (module) => module.read(turn), COGNITIVE_MODULE_DEADLINE_MS)) {
    if (outcome.status === 'ok') blocks.push(...outcome.value);
    else {
      failed.push(outcome.module.key);
      // 只记模块、用户和失败类型：模块的报错原文里常常带着记忆正文或密钥片段。
      log.warn('cognitive.read_failed', { module: outcome.module.key, userId: turn.userId, reason: outcome.reason });
    }
  }
  return { blocks, failed };
}

/** 一条失败：模块键 + 是抛错还是超时。worker 靠 reason 决定「退避重试」还是「判 DEAD」。 */
export interface CognitiveWriteFailure {
  module: CognitiveModuleKey;
  reason: 'error' | 'timeout';
}

export interface CognitiveWriteResult {
  /** 开关打开、确实跑了的模块。空数组意味着「这一轮没有模块要做」，和「都失败了」不是一回事。 */
  attempted: CognitiveModuleKey[];
  failed: CognitiveWriteFailure[];
}

/**
 * 跑这一轮的写侧。契约有两条：返回的 promise 永不 reject；截止由调用方给。
 *
 * 第二条是这一片新加的要求——后台 worker 一轮要解密一整池候选、写十来条语句，
 * 拿对话读侧那 1 秒去卡它，只会把每条任务都判成超时。
 */
export async function runCognitiveWrites(
  turn: CognitiveTurn,
  deadlineMs: number = COGNITIVE_MODULE_DEADLINE_MS
): Promise<CognitiveWriteResult> {
  const enabled = (await enabledModules(turn.userId)).filter((module) => module.write);
  const failed: CognitiveWriteFailure[] = [];
  for (const outcome of await settleAll(enabled, (module) => module.write!(turn), deadlineMs)) {
    if (outcome.status !== 'ok') {
      failed.push({ module: outcome.module.key, reason: outcome.reason });
      log.warn('cognitive.write_failed', { module: outcome.module.key, userId: turn.userId, reason: outcome.reason });
    }
  }
  return { attempted: enabled.map((module) => module.key), failed };
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
  return [...registry.values()].filter((module) => preferences[MODULE_SWITCH[module.key]] === true);
}

type Outcome<T> =
  | { status: 'ok'; module: CognitiveModule; value: T }
  | { status: 'failed'; module: CognitiveModule; reason: 'error' | 'timeout' };

function settleAll<T>(
  modules: CognitiveModule[],
  run: (module: CognitiveModule) => Promise<T>,
  deadlineMs: number
): Promise<Array<Outcome<T>>> {
  return Promise.all(modules.map((module) => settle(module, () => run(module), deadlineMs)));
}

/**
 * run 收的是函数不是 promise：模块函数**同步**抛错时，promise 根本还没诞生，
 * 提前求值会让整条 settleAll 直接抛出来。以前外面还有一层 fire-and-forget 兜住，
 * 现在调用方是 await 它的 worker，这条洞得在这儿补。
 */
async function settle<T>(module: CognitiveModule, run: () => Promise<T>, deadlineMs: number): Promise<Outcome<T>> {
  let task: Promise<T>;
  try {
    task = run();
  } catch {
    return { status: 'failed', module, reason: 'error' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
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
