/**
 * 回答策略类型（Phase 3）。一个回答可组合多种策略。
 * 这些是内部规划词汇，不展示给用户。
 */
export const RESPONSE_STRATEGIES = [
  'DIRECT_ANSWER',
  'CONTINUE',
  'EXPLAIN',
  'DEEPEN',
  'CHALLENGE',
  'CONNECT',
  'COMPARE',
  'CLARIFY',
  'REFLECT'
] as const;

export type ResponseStrategy = (typeof RESPONSE_STRATEGIES)[number];

export const STRATEGY_TEXT: Record<ResponseStrategy, string> = {
  DIRECT_ANSWER: '先直接给出用户要的结论或答案。',
  CONTINUE: '自然承接用户上一句，不另起模板化开头。',
  EXPLAIN: '解释概念与原因，优先用具体例子。',
  DEEPEN: '深入到机制与背景，不停留在表面罗列。',
  CHALLENGE: '若用户假设有问题，指出并解释，不为赞同而赞同。',
  CONNECT: '在确实有助理解时联系历史记忆或其他领域知识。',
  COMPARE: '比较不同观点/方案的利弊与适用条件。',
  CLARIFY: '信息不足时先问关键细节，不臆测。',
  REFLECT: '提供一层更深的观察或元视角。'
};
