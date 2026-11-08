import type { ConversationMode } from '../mode/conversation-mode';
import type { ConversationStyle } from '../core/conversation-policy';
import { STRATEGY_TEXT, type ResponseStrategy } from './response-strategy';

/**
 * Response Planner（Phase 3）。轻量、纯规则，不单独调用模型（计划书 5.4 / 11.1）：
 * 简单问题在同一次生成里完成判断+回答；这里只产出一段内部策略提示，交给同一次调用。
 * 仅当复杂度高时才在 planText 里要求更完整的组织（仍不额外调用模型）。
 *
 * 规划输出不展示给用户，只作为低优先级提示注入。
 */

export interface ResponsePlan {
  mode: ConversationMode;
  strategies: ResponseStrategy[];
  responseDepth: 'shallow' | 'medium' | 'deep';
  responseLength: 'short' | 'medium' | 'long';
  structurePreference: 'prose' | 'dynamic' | 'structured';
  clarificationRequired: boolean;
  planText: string;
}

export function planResponse(input: {
  mode: ConversationMode;
  content: string;
  style: ConversationStyle;
  hasPersonalMemory: boolean;
}): ResponsePlan {
  const text = input.content;
  const strategies: ResponseStrategy[] = [];

  const isQuestion = /[？?]\s*$|是什么|为什么|怎么做|如何|吗\s*$/.test(text);
  const isShort = text.length <= 40;
  const isComplex = text.length > 120 || (text.match(/[？?；;]/g) ?? []).length >= 2;
  const hasWrongAssumption = /我觉得.*一定|肯定|总是|从来|所有人都|显然/.test(text);
  const isVague = isShort && !isQuestion && !/你好|谢谢|嗯|好的/.test(text);

  // 基础策略：问句→直接回答/解释；闲聊→承接。
  if (isQuestion) strategies.push('DIRECT_ANSWER');
  else strategies.push('CONTINUE');

  switch (input.mode) {
    case 'TUTOR':
      strategies.push('EXPLAIN');
      if (isComplex || /为什么|原理|机制/.test(text)) strategies.push('DEEPEN');
      break;
    case 'TECHNICAL_EXPERT':
      strategies.push('EXPLAIN', 'DEEPEN');
      break;
    case 'DEEP_DISCUSSION':
      strategies.push('DEEPEN', 'REFLECT');
      break;
    case 'THINKING_PARTNER':
      strategies.push('REFLECT');
      if (hasWrongAssumption) strategies.push('CHALLENGE');
      break;
    case 'RESEARCH':
      strategies.push('COMPARE');
      break;
    case 'CREATIVE':
      strategies.push('COMPARE');
      break;
    case 'EMOTIONAL':
      // 情绪模式不强行分析/给方案，只承接与理解。
      strategies.length = 0;
      strategies.push('CONTINUE');
      break;
    default:
      break;
  }

  if (hasWrongAssumption && input.mode !== 'EMOTIONAL' && !strategies.includes('CHALLENGE')) {
    strategies.push('CHALLENGE');
  }
  if (input.hasPersonalMemory && /我的|我之前|上次|继续/.test(text) && !strategies.includes('CONNECT')) {
    strategies.push('CONNECT');
  }
  if (isVague && input.mode !== 'EMOTIONAL') strategies.push('CLARIFY');

  const depth: ResponsePlan['responseDepth'] =
    input.mode === 'NATURAL_CHAT' || input.mode === 'EMOTIONAL'
      ? 'shallow'
      : isComplex || input.style.knowledgeDepth === 'high'
        ? 'deep'
        : 'medium';

  const length: ResponsePlan['responseLength'] =
    input.style.length === 'short' || (isShort && input.mode === 'NATURAL_CHAT')
      ? 'short'
      : depth === 'deep'
        ? 'long'
        : 'medium';

  const structure: ResponsePlan['structurePreference'] =
    input.style.structure === 'minimal' || input.mode === 'NATURAL_CHAT' || input.mode === 'EMOTIONAL'
      ? 'prose'
      : input.style.structure === 'rich' || (isComplex && (input.mode === 'TECHNICAL_EXPERT' || input.mode === 'RESEARCH'))
        ? 'structured'
        : 'dynamic';

  const plan: ResponsePlan = {
    mode: input.mode,
    strategies,
    responseDepth: depth,
    responseLength: length,
    structurePreference: structure,
    clarificationRequired: strategies.includes('CLARIFY'),
    planText: ''
  };
  plan.planText = renderPlan(plan);
  return plan;
}

function renderPlan(plan: ResponsePlan): string {
  const lines = [
    `【回答策略·内部】深度=${plan.responseDepth}；长度=${plan.responseLength}；结构=${plan.structurePreference}。`,
    ...plan.strategies.map((s) => `- ${STRATEGY_TEXT[s]}`)
  ];
  if (plan.clarificationRequired) lines.push('- 信息不足，先澄清关键细节再回答。');
  return lines.join('\n');
}
