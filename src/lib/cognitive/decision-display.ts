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

/**
 * 空态那句话里举的说法（任务书 5.5 界面那一半的诚实性）。
 *
 * 面板原来写「你在对话里说「我决定……」时，这里会出现待确认的候选」。对着 v1 的词表看，
 * 那是空头承诺：`我决定` 只在动词表里，类别词表要的是 `我决定用 / 我改用 / 我打算学`
 * 这一类硬短语（那条边界是实测出来的，记在验收文档片P-3 第八节）。
 *
 * 空态是用户和这一屏的第一次接触，它说错了用户就会以为自己说了却没被记下来，
 * 于是开始把「系统没记」理解成「我表达得不好」。所以这里只举真能产出候选的说法，
 * 例子由 `cognitive-decision-intake-copy.test.ts` 拿去跑真实抽取器，不由注释担保；
 * 以后词表扩了，加进来的例子必须先通过那一道，这句话才不会跑在能力前面。
 */
export const DECISION_INTAKE_EXAMPLES = ['我决定用', '我改用', '我打算学'] as const;

const quotedExamples = DECISION_INTAKE_EXAMPLES.map((example) => `「${example}……」`);

export const DECISION_EMPTY_STATE_DESCRIPTION = `你在对话里说${quotedExamples.join('')}这类明确说法时，这里会出现待确认的候选。`;
