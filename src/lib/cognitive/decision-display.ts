import { formatDate } from './memory-display';

/**
 * 决策两列的展示口径（任务书 5.2 的「预期结果」与「可选的后续复盘时间」）。
 *
 * 和 `outcome-display.ts` 是同一个决定的另一半：那一边管结果的四列，这一边管决策自己的
 * 两列。两边共用一条规则——**库里是 null 的列不出行**。这两列的 null 尤其常见，
 * 因为写侧只在用户真的说过期待、真的安排过复盘时才填；给它们摆一行空标签，
 * 用户看到的就成了「我说过但没写」，而这一屏下一步正请他确认「我到底说过什么」。
 *
 * 复盘日期走 `memory-display.ts` 的 formatDate：全项目的「年月日」那套口径只有那一份，
 * 精度按 day 给——`review-schedule.ts` 算出来的是「第 N 天」这种整日的东西，
 * 显示到分钟是在替它编一个它没有的精度。
 *
 * 测试：tests/unit/cognitive-decision-display.test.ts
 */
export const DECISION_DETAIL_ROWS = [
  { field: 'expectedOutcome', label: '当初的预期' },
  { field: 'reviewAfter', label: '计划复盘' }
] as const;

type DecisionDetailField = (typeof DECISION_DETAIL_ROWS)[number]['field'];

/** 一列一段原话：预期那列库里存的就是要显示的那句，复盘那列只有日期需要转成文字。 */
function textOf(decision: { expectedOutcome: string | null; reviewAfter: string | null }, field: DecisionDetailField): string | null {
  if (field === 'expectedOutcome') return decision.expectedOutcome;
  return decision.reviewAfter === null ? null : formatDate(decision.reviewAfter, 'day');
}

export function decisionDetailRows(
  decision: { expectedOutcome: string | null; reviewAfter: string | null }
): Array<{ label: string; text: string }> {
  return DECISION_DETAIL_ROWS.flatMap(({ field, label }) => {
    const text = textOf(decision, field);
    return text === null ? [] : [{ label, text }];
  });
}
