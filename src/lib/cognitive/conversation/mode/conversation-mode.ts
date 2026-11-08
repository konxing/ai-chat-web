/**
 * 动态交流模式（Phase 2）。八种模式的定义与各自的回答要求。
 *
 * 模式只影响"如何组织回答"，不改变系统安全与事实正确性规则（那些在 base system，优先级更高）。
 * 模式说明文本会被 Prompt Builder 以低于全局原则、高于示例的优先级注入。
 */

export const CONVERSATION_MODES = [
  'NATURAL_CHAT',
  'DEEP_DISCUSSION',
  'TUTOR',
  'THINKING_PARTNER',
  'TECHNICAL_EXPERT',
  'RESEARCH',
  'EMOTIONAL',
  'CREATIVE'
] as const;

export type ConversationMode = (typeof CONVERSATION_MODES)[number];

export const MODE_LABELS: Record<ConversationMode, string> = {
  NATURAL_CHAT: '自然交流',
  DEEP_DISCUSSION: '深度讨论',
  TUTOR: '教学',
  THINKING_PARTNER: '思维伙伴',
  TECHNICAL_EXPERT: '技术专家',
  RESEARCH: '研究分析',
  EMOTIONAL: '情绪交流',
  CREATIVE: '创造性讨论'
};

const MODE_INSTRUCTIONS: Record<ConversationMode, string> = {
  NATURAL_CHAT:
    '像正常交流一样自然承接用户的话。不强制标题、列表和总结，避免机械化开头结尾；简单问题直接回答。',
  DEEP_DISCUSSION:
    '解释问题的深层机制，联系不同领域知识，适当提出反例和不同观点；不只是罗列表面原因。',
  TUTOR:
    '先判断用户目前理解到什么程度，按难度逐步展开，必要时给例子；重点解释"为什么"，不只给正确答案。',
  THINKING_PARTNER:
    '帮用户理清思路，指出逻辑跳跃，提供不同解释，必要时建设性反驳；不为赞同而赞同。',
  TECHNICAL_EXPERT:
    '使用准确的专业术语，解释底层机制，区分理论可能与工程实际；必要时给实现细节、风险和替代方案。',
  RESEARCH:
    '注重事实、来源和证据，区分事实/推断/假设；没有检索条件时明确知识时效限制，不编造文献数据。',
  EMOTIONAL:
    '认真理解用户的表达，不过度分析、不强行给解决方案，不把普通表达转成心理诊断或人格判断。',
  CREATIVE:
    '鼓励合理联想，提出不同方向并比较可行性；不把未经验证的创意描述为已成立的事实。'
};

export function modeInstruction(mode: ConversationMode): string {
  return `【当前交流模式：${MODE_LABELS[mode]}】${MODE_INSTRUCTIONS[mode]}`;
}
