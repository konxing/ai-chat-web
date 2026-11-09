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
  ACKNOWLEDGE_AND_EXPLORE: '先承接用户的感受/进展，不急着给方案；可轻声邀请多说一点。',
  ASK_ONE_CLARIFICATION: '只问一个真正必要的澄清问题，不连环追问。',
  CO_REASON: '和用户一起推理，提供不同解释而非替他下结论。',
  OFFER_PERSPECTIVE: '自然提出自己的看法与理据，不机械附和也不争辩。',
  CORRECT_COURSE: '承认上轮理解偏差，按用户纠正调整，不重复原错误路径。',
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
  if (u.needsRepair || repair || state.recentCorrection) {
    const note = repair?.correctedExpectation
      ? (repair.type === 'TOPIC' ? repair.correctedExpectation : `修复方向：${repair.correctedExpectation}`)
      : '按用户纠正调整，不重复原错误路径。';
    return { primary: 'CORRECT_COURSE', secondary: null, rationale: '用户纠正上轮理解', contextNote: [note, constraintNote].filter(Boolean).join(' ') };
  }
  // 防止连环追问：上轮已问且未答，本轮不再追问。
  const avoidAsk = state.openLoop !== null;

  const base = selectBaseAct(u, state, avoidAsk);
  // B2 追问价值预算：抑制非必要澄清；分享/已知信息不追问；仅 ESSENTIAL 才问一个。
  const question = decideQuestion({ content, understanding: u, state });
  let primary = base.primary;
  if (primary === 'ASK_ONE_CLARIFICATION' && question.responseMove !== 'ASK_ONE') {
    primary = 'ANSWER';
  }
  // A.5：naturalness 有可观测行为差异。低自然度=偏直接、信息密度高：分享/倾诉不铺陈承接，直接回应。
  if (naturalness === 'low' && primary === 'ACKNOWLEDGE_AND_EXPLORE') {
    primary = 'ANSWER';
  }
  const merged: ActSelection = { ...base, primary, question };
  return constraintNote ? { ...merged, contextNote: constraintNote } : merged;
}

function selectBaseAct(u: DialogueUnderstanding, state: ConversationState, avoidAsk: boolean): ActSelection {
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
    default: {
      // UNCLEAR：低置信不必然追问；用户明显要直接答案时先给初步回答并说明假设。
      if (u.intentConfidence === 'low' && !avoidAsk && state.topic === null) {
        return { primary: 'ASK_ONE_CLARIFICATION', secondary: null, rationale: 'truly 模糊且无上下文' };
      }
      return { primary: 'ANSWER', secondary: null, rationale: '模糊但先给有用初步回答' };
    }
  }
}
