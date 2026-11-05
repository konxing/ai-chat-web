import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';
import { getCognitivePreferences } from './preferences';
import {
  MEMORY_CONTEXTS,
  applyLearnedPolicy,
  getMemoryPolicy,
  toDbMemoryContext,
  type MemoryContext
} from './policy';
import type { Prisma } from '@prisma/client';

/**
 * MemoryPolicyLearner（任务书 1.3 反馈学习）。
 *
 * 立场是「系统无条件记住一切是错的」，但学习层能做的只有收紧，而且必须克制：
 *
 * 一、只认明确操作。这里算证据的只有两种：把一句话**永久删掉**，和对着一条待确认候选
 *    说「不要记」。它们说的是同一件事——「这句话我不想要你记住」——所以共用同一个闸门、
 *    同一张信号表、同一条阈值。撤回不算，用户撤回可能只是不想让 AI 再用这一条，
 *    不等于抱怨这个情境记太多；改记忆更不算，那是想让它记对。
 *    聊天次数、停留时间这类弱信号一律不用（任务书明令禁止）。
 * 二、分情境学。技术项目里连删三条，不许顺手把私人倾诉也收紧。
 * 三、先攒证据，够 3 次、且在 30 天窗口内，才生成并应用候选更新。
 * 四、只往更保守的方向走：唯一能改的是 requireConfirmation → true。
 *    放宽只能用户自己在策略界面点，学习层永远不会替用户把权限打开。
 * 五、用户亲手改过的情境就此归用户管（manualOverrideAt），学习层不再碰。
 *    否则用户改回宽松、它下一轮又改严，就是在和用户抢方向盘——
 *    任务书最后一句禁止的正是「把自己的推断凌驾于用户真实表达之上」。
 *
 * 生效是自动的，但不许是隐形的：策略界面会把「这一条是自动收紧的」标出来，
 * 「恢复默认」同时清掉学习记录、接管标记和已攒的证据。
 *
 * 测试：tests/unit/cognitive-policy-learner.test.ts
 */

export const POLICY_LEARNING_THRESHOLD = 3;
export const POLICY_LEARNING_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type LearningReason =
  | 'applied'
  | 'manual_override'
  | 'already_learned'
  | 'insufficient_evidence'
  | 'already_conservative';

export interface LearningOutcome {
  applied: boolean;
  reason: LearningReason;
}

export interface PolicyLearningState {
  learnedAt: string | null;
  manualOverrideAt: string | null;
}

interface SignalRow {
  context: string;
  learnedAt: Date | null;
  manualOverrideAt: Date | null;
}

/**
 * 记一条学习证据。跟着删除走同一个事务：
 * 「行删掉了但证据没记上」会让用户以为自己的操作被忽略了。
 * 信号里只有情境和时间，没有正文，也没有被删记忆的 id——它只回答「这个情境被删过几次」。
 */
export async function recordPolicySignal(
  tx: Prisma.TransactionClient,
  userId: string,
  context: MemoryContext
): Promise<void> {
  await tx.memoryPolicySignal.create({
    data: { id: randomUUID(), userId, context: toDbMemoryContext(context) }
  });
}

/**
 * 学习层唯一的闸门：偏好表里的第八个开关（`adaptiveMemoryEnabled`）。
 *
 * 读不出来当关——和 `manager.ts` 的 `enabledModules` 同一个立场：认知引擎宁可什么都不做，
 * 也不能在用户没表达过的情况下自己学会点什么。
 */
export async function policyLearningEnabled(userId: string): Promise<boolean> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return preferences.adaptiveMemoryEnabled;
  } catch {
    log.warn('cognitive.policy_preferences_unavailable', { userId });
    return false;
  }
}

/** 操作提交之后调用：证据够了就把这个情境收紧成「先问再记」。名字里不写「删除」，因为拒绝也算一次。 */
export async function learnFromSignals(userId: string, context: MemoryContext): Promise<LearningOutcome> {
  const state = await readLearningState(userId, context);
  if (state.manualOverrideAt) return { applied: false, reason: 'manual_override' };
  // 收紧过一次就不再重复：再删也只是同一件事的重复表达，不该反复盖时间戳。
  if (state.learnedAt) return { applied: false, reason: 'already_learned' };

  const since = new Date(Date.now() - POLICY_LEARNING_WINDOW_DAYS * DAY_MS);
  const evidence = await prisma.memoryPolicySignal.count({
    where: { userId, context: toDbMemoryContext(context), createdAt: { gte: since } }
  });
  if (evidence < POLICY_LEARNING_THRESHOLD) return { applied: false, reason: 'insufficient_evidence' };

  const policy = await getMemoryPolicy(userId, context);
  if (policy.requireConfirmation) return { applied: false, reason: 'already_conservative' };

  await applyLearnedPolicy(userId, context);
  return { applied: true, reason: 'applied' };
}

/**
 * 一次删除或一次拒绝提交之后，对每个受影响的情境各跑一次学习，返回真的被收紧的那些。
 *
 * 学习失败不许让删除失败：行已经删掉了，那是用户要的结果，
 * 不能因为附带效果报错就把 200 变成 500、让用户以为没删掉。
 * 日志里只有 userId 和情境，没有正文，也没有错误原文（任务书 5.5）。
 */
export async function learnAfterSignals(
  userId: string,
  contexts: readonly MemoryContext[]
): Promise<MemoryContext[]> {
  // 闸门放在这里，四条链路（单条 / 按会话 / 清空 / 拒绝候选）一起盖住，route 不用各自记得问一遍。
  if (!(await policyLearningEnabled(userId))) return [];
  const learned: MemoryContext[] = [];
  for (const context of contexts) {
    try {
      const outcome = await learnFromSignals(userId, context);
      if (outcome.applied) learned.push(context);
    } catch {
      log.warn('cognitive.policy_learning_failed', { userId, context });
    }
  }
  return learned;
}

/** 七个情境各一份学习状态；库里没有行的就是两个 null。 */
export async function getPolicyLearningStates(
  userId: string
): Promise<Record<MemoryContext, PolicyLearningState>> {
  const rows = (await prisma.memoryPolicy.findMany({
    where: { userId },
    select: { context: true, learnedAt: true, manualOverrideAt: true }
  })) as unknown as SignalRow[];
  const stored = new Map(rows.map((row) => [row.context, row]));

  const states = {} as Record<MemoryContext, PolicyLearningState>;
  for (const context of MEMORY_CONTEXTS) {
    const row = stored.get(toDbMemoryContext(context));
    states[context] = {
      learnedAt: row?.learnedAt ? row.learnedAt.toISOString() : null,
      manualOverrideAt: row?.manualOverrideAt ? row.manualOverrideAt.toISOString() : null
    };
  }
  return states;
}

async function readLearningState(userId: string, context: MemoryContext): Promise<PolicyLearningState> {
  const row = (await prisma.memoryPolicy.findFirst({
    where: { userId, context: toDbMemoryContext(context) },
    select: { learnedAt: true, manualOverrideAt: true }
  })) as { learnedAt: Date | null; manualOverrideAt: Date | null } | null;
  return {
    learnedAt: row?.learnedAt ? row.learnedAt.toISOString() : null,
    manualOverrideAt: row?.manualOverrideAt ? row.manualOverrideAt.toISOString() : null
  };
}
