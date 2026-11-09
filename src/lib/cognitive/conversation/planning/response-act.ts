import type { DialogueUnderstanding } from '../understanding/dialogue-act';
import type { ConversationState } from '../state/conversation-state';
import { decideQuestion, type QuestionDecision } from './question-budget';

/**
 * 回应动作选择（P1/P2，修复 F-06）。一次选最有价值的 primaryResponseAct + 0-1 次动作，
 * 不每轮累加 EXPLAIN/DEEPEN/REFLECT/CHALLENGE 全写入 Prompt。
 * 先决定如何承接用户，再决定是否展开知识。
 */

export const RESPONSE_ACTS = [
  'ANSWER', 'EXPLAIN', 'ACKNOWLEDGE_AND_EXPLORE', 'ASK_ONE_CLARIFICATION',
  'CO_REASON', 'OFFER_PERSPECTIVE', 'CORRECT_COURSE', 'SUGGEST_ACTION'
] as const;
export type ResponseAct = (typeof RESPONSE_ACTS)[number];

export interface ActSelection {
  primary: ResponseAct;
  secondary: ResponseAct | null;
  rationale: string;
  /** v1.3：来自修复账本/约束账本的当轮补充说明（注入提示词，非用户隐私全文）。 */
  contextNote?: string;
  /** v1.3 B2：追问价值预算判定（供诊断/评测，非用户隐私全文）。 */
  question?: QuestionDecision;
}

export const ACT_TEXT: Record<ResponseAct, string> = {
  ANSWER: '直接给出有用的答案或结论。',
  EXPLAIN: '解释概念与原因，优先具体例子。',
  ACKNOWLEDGE_AND_EXPLORE: '就用户在意的具体细节接话，可以给一个贴切的观察；有内容即可收住，用户想要建议时再给。',
  ASK_ONE_CLARIFICATION: '只问一个真正必要的澄清问题，不连环追问。',
  CO_REASON: '和用户一起推理，提供不同解释而非替他下结论。',
  OFFER_PERSPECTIVE: '自然提出自己的看法与理据，不机械附和也不争辩。',
  CORRECT_COURSE: '按用户澄清后的意思接话。只有前文明示你确实误解了才简短承认；没有发生过的误解或回复不要补写。',
  SUGGEST_ACTION: '在用户明确要行动建议时给出可执行下一步。'
};

export function selectResponseAct(
  u: DialogueUnderstanding,
  state: ConversationState,
  content = '',
  naturalness: 'low' | 'medium' | 'high' = 'high'
): ActSelection {
  // 约束账本：本轮仍有效的用户直接约束，作为补充说明注入（不覆盖安全/事实）。
  const constraintNote = state.activeConstraints.length
    ? '本轮遵守用户明确要求：' + state.activeConstraints.map((c) => c.content).join('；') + '。'
    : undefined;

  // 纠错优先：用户纠正后必须修复，按修复账本的正确期待调整，不继续推方案/长报告。
  const repair = state.currentRepair;
  if (repair?.type === 'TOPIC') {
    return {
      primary: 'ANSWER',
      secondary: null,
      rationale: '用户主动换话题',
      contextNote: [
        '旧话题到此为止，无需评论、总结或道歉。用户给了新话题就直接回答；还没给就用一句轻松的话接住转场，可以问一句想聊什么，不要猜主题或罗列选项。只有用户请你起话题时才主动起一个。',
        constraintNote
      ].filter(Boolean).join(' ')
    };
  }
  if (u.needsRepair || repair || state.recentCorrection) {
    const note = repair?.correctedExpectation
      ? `修复方向：${repair.correctedExpectation}`
      : '按用户纠正调整，不重复原错误路径。';
    return { primary: 'CORRECT_COURSE', secondary: null, rationale: '用户纠正上轮理解', contextNote: [note, constraintNote].filter(Boolean).join(' ') };
  }
  // 追问预算决定动作，也决定传给模型的当轮提示。
  const question = decideQuestion({ content, understanding: u, state });
  const base: ActSelection = question.responseMove === 'ASK_ONE'
    ? { primary: 'ASK_ONE_CLARIFICATION', secondary: null, rationale: '完成请求缺少关键信息' }
    : selectBaseAct(u);
  let primary = base.primary;
  // A.5：naturalness 有可观测行为差异。低自然度=偏直接、信息密度高：分享/倾诉不铺陈承接，直接回应。
  if (naturalness === 'low' && primary === 'ACKNOWLEDGE_AND_EXPLORE') {
    primary = 'ANSWER';
  }
  // B1：纠正后 TTL 内持续抑制重犯错（当前轮已单独处理；此处覆盖后续有限轮）。
  const priorRepair = [...state.repairLedger]
    .reverse()
    .find((e) => e.type === 'INTENT' || e.type === 'STYLE');
  const repairNote = priorRepair ? `此前用户纠正过：${priorRepair.correctedExpectation}` : undefined;
  const questionNote = question.responseMove === 'ASK_ONE'
    ? `本轮只澄清一项缺失信息：${question.essentialMissing[0]}。问完等用户回答。`
    : question.responseMove === 'CONTINUE_WITHOUT_QUESTION'
      ? '本轮用观察或观点接住用户的话，说到完整处就停，不用问题或邀请来收尾。'
      : '直接给出当前能确定的内容，必要时说明假设；不附加可有可无的追问。' +
        (question.alreadyKnown.includes('日期') ? '沿用用户给出的日期和已明确的行程条件，不再索取日期或可选偏好。' : '');
  const notes = [constraintNote, repairNote, questionNote].filter(Boolean).join(' ');
  const merged: ActSelection = { ...base, primary, question };
  return notes ? { ...merged, contextNote: notes } : merged;
}

function selectBaseAct(u: DialogueUnderstanding): ActSelection {
  switch (u.dialogueAct) {
    case 'VENT':
    case 'SHARE_PROGRESS':
    case 'SHARE_EXPERIENCE':
      return { primary: 'ACKNOWLEDGE_AND_EXPLORE', secondary: null, rationale: '分享/倾诉，先承接不给方案' };
    case 'ACKNOWLEDGE':
      return { primary: 'ACKNOWLEDGE_AND_EXPLORE', secondary: null, rationale: '用户简单确认，自然承接' };
    case 'ASK_EXPLANATION':
      return { primary: 'EXPLAIN', secondary: u.topicDomain === 'technical' ? 'ANSWER' : null, rationale: '请求解释' };
    case 'ASK_FACT':
      return { primary: 'ANSWER', secondary: null, rationale: '事实问题直接答' };
    case 'ASK_ADVICE':
      return { primary: 'SUGGEST_ACTION', secondary: 'CO_REASON', rationale: '明确要建议' };
    case 'EXPLORE_OPINION':
    case 'CHALLENGE':
      return { primary: 'OFFER_PERSPECTIVE', secondary: 'CO_REASON', rationale: '观点讨论，独立看法' };
    case 'CORRECT_ASSISTANT':
      return { primary: 'CORRECT_COURSE', secondary: null, rationale: '纠错' };
    default:
      return { primary: 'ANSWER', secondary: null, rationale: '模糊但先给有用初步回答' };
  }
}
