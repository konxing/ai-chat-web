import type { DialogueUnderstanding } from '../understanding/dialogue-act';
import type { ConversationState } from '../state/conversation-state';

/**
 * 追问价值预算（v1.3 附录 B2，研究依据 Don't Guess Ask Wisely / Ask Less Ask Better）。
 *
 * 判定"该不该问、问什么"，而不是"结尾要不要说一句"。纯规则、零额外模型调用。
 * 目标：避免每轮结尾形式化问句；分享/倾诉不强制追问；已知信息不重复索取；
 * 确实缺关键事实时只问一个信息价值最高的问题；可安全默认的任务直接完成并披露假设。
 * 不以"减少问号数"为唯一目标（绝不提问刷自然度同样是退化）。
 */

export type QuestionMove = 'ANSWER_NOW' | 'ASK_ONE' | 'OFFER_CHOICES' | 'CONTINUE_WITHOUT_QUESTION';
export type QuestionReason = 'ESSENTIAL' | 'OPTIONAL' | 'SHARING' | 'ALREADY_KNOWN' | 'LOW_VALUE';

export interface QuestionDecision {
  /** 不问就无法准确完成用户任务的信息。 */
  essentialMissing: string[];
  /** 最近对话已给出、不应再索取的信息。 */
  alreadyKnown: string[];
  expectedInformationGain: 'low' | 'medium' | 'high';
  userAttentionCost: 'low' | 'medium' | 'high';
  responseMove: QuestionMove;
  reasonCode: QuestionReason;
}

const SHARING_ACTS = new Set(['SHARE_EXPERIENCE', 'SHARE_PROGRESS', 'VENT', 'EXPLORE_OPINION', 'CHALLENGE', 'ACKNOWLEDGE']);

// 需要关键槽位才能完成的任务，及对应缺失检测（保守：只在明确任务且槽位缺失时判 ESSENTIAL）。
const SLOT_TASKS: Array<{ trigger: RegExp; slot: string; present: RegExp; safeDefault: boolean }> = [
  { trigger: /预订|订一下|帮我订|买.*票/, slot: '日期/时间', present: /\d{1,2}月|\d{1,2}号|明天|后天|周[一二三四五六日末]|\d{4}-\d{2}/, safeDefault: false },
  { trigger: /推荐.*预算|按预算|预算内/, slot: '预算上限', present: /\d+\s*(元|块|万|k|K)|预算\s*\d+/, safeDefault: false },
  { trigger: /帮我.*选|怎么选.*取决于/, slot: '关键约束/偏好', present: /更看重|主要|优先|必须|不能/, safeDefault: true }
];

export function decideQuestion(input: {
  content: string;
  understanding: DialogueUnderstanding;
  state: ConversationState;
}): QuestionDecision {
  const { content, understanding: u, state } = input;
  const decision: QuestionDecision = {
    essentialMissing: [],
    alreadyKnown: [],
    expectedInformationGain: 'low',
    userAttentionCost: 'medium',
    responseMove: 'ANSWER_NOW',
    reasonCode: 'OPTIONAL'
  };

  // 分享/倾诉/观点：自然接话即可，不把追问当作"完整回答"的必要条件。
  if (SHARING_ACTS.has(u.dialogueAct)) {
    decision.responseMove = 'CONTINUE_WITHOUT_QUESTION';
    decision.reasonCode = 'SHARING';
    decision.userAttentionCost = 'low';
    return decision;
  }

  // 上轮助手已问且未答：不重复索取（降低 repeat_question_rate）。
  if (state.openLoop) {
    decision.alreadyKnown.push('上一轮已提出的问题尚未回答');
    decision.responseMove = 'ANSWER_NOW';
    decision.reasonCode = 'ALREADY_KNOWN';
    return decision;
  }

  // 纠错轮：先修复，不追问。
  if (u.needsRepair || state.currentRepair) {
    decision.responseMove = 'ANSWER_NOW';
    decision.reasonCode = 'LOW_VALUE';
    return decision;
  }

  // 关键槽位检测：明确任务且槽位缺失。
  let matchedTask = false;
  for (const task of SLOT_TASKS) {
    if (!task.trigger.test(content)) continue;
    matchedTask = true;
    if (task.present.test(content)) {
      decision.alreadyKnown.push(task.slot);
      continue;
    }
    if (task.safeDefault) {
      // 可安全使用合理假设：直接完成并披露假设，不抢占对话回合。
      decision.responseMove = 'ANSWER_NOW';
      decision.reasonCode = 'OPTIONAL';
      decision.expectedInformationGain = 'low';
      return decision;
    }
    decision.essentialMissing.push(task.slot);
    decision.expectedInformationGain = 'high';
    decision.userAttentionCost = 'medium';
    decision.responseMove = 'ASK_ONE';
    decision.reasonCode = 'ESSENTIAL';
    return decision;
  }
  // 明确任务且槽位齐全：直接完成，不因表面 UNCLEAR 再追问。
  if (matchedTask) {
    decision.responseMove = 'ANSWER_NOW';
    decision.reasonCode = decision.alreadyKnown.length ? 'ALREADY_KNOWN' : 'LOW_VALUE';
    return decision;
  }

  // 真正模糊且无上下文：信息增益中等，可问一个；否则先给有用初步回答。
  if (u.dialogueAct === 'UNCLEAR' && u.intentConfidence === 'low' && state.topic === null) {
    decision.expectedInformationGain = 'medium';
    decision.responseMove = 'ASK_ONE';
    decision.reasonCode = 'ESSENTIAL';
    return decision;
  }

  decision.responseMove = 'ANSWER_NOW';
  decision.reasonCode = 'LOW_VALUE';
  return decision;
}