import type { DecisionStatus } from '@prisma/client';

/**
 * 「用户确认过的决策」到底是库里哪几种状态（任务书 5.1 + 7.4 门槛 8）。
 *
 * 单独立一个叶子模块，是因为这个判断同时被三处需要：写结果的匹配池、发问时的召回池、
 * 反思那一侧的里程碑依据。让它住在 `decisions.ts` 里，纯函数那几侧就得把 prisma 一起拖进来。
 *
 * 为什么不能写死 `status === 'CONFIRMED'`：这五个值不是一组互斥标签，而是一条进度链
 * `PENDING_CONFIRM → CONFIRMED → AWAITING_REVIEW / OUTCOME_RECORDED`（`REJECTED` 是岔出去的死路）。
 * 一条决策走到「记录过结果」那一站，它的经验恰恰最该被召回；把它从池子里踢掉，
 * 等于用户越认真复盘，系统越忘得干净。
 */
export const CONFIRMED_DECISION_STATUSES: readonly DecisionStatus[] = [
  'CONFIRMED',
  'AWAITING_REVIEW',
  'OUTCOME_RECORDED'
];

export function isConfirmedDecision(status: DecisionStatus): boolean {
  return CONFIRMED_DECISION_STATUSES.includes(status);
}
