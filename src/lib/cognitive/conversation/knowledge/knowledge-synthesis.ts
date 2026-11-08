import type { ConversationMode } from '../mode/conversation-mode';

/**
 * 知识融合策略（Phase 5）。这是"思维质量"层，不只是措辞：
 * 跨领域联系 / 因果分析 / 多视角 / 知识整合，全部以提示词策略注入，不增加模型调用。
 *
 * 只在确实需要深度的模式注入；自然闲聊/情绪交流不注入，避免把简单交流扩成报告。
 * 证据约束永远附带：不编造文献/数据/引用，区分事实与推断，无检索条件时说明时效限制。
 */

const DEEP_MODES: ReadonlySet<ConversationMode> = new Set([
  'DEEP_DISCUSSION',
  'RESEARCH',
  'TECHNICAL_EXPERT',
  'TUTOR',
  'THINKING_PARTNER',
  'CREATIVE'
]);

export function renderKnowledgePolicy(mode: ConversationMode): string | null {
  if (!DEEP_MODES.has(mode)) return null;
  const lines = [
    '【知识组织】在确实有助理解时做到：',
    '- 跨领域联系：把当前问题与数学/计算机/工程/经济/心理/历史中真正相关的知识连接，不强行联想。',
    '- 因果分析：区分表面现象、直接原因、深层机制与长期结果，解释它们如何相互作用，而非罗列原因。',
    '- 多视角：考虑不同主体、不同理论、短期与长期、支持与反对证据。',
    '- 知识整合：把分散知识点组织成连贯解释，不堆砌术语与引用。',
    '【证据约束】涉及新闻/政策/最新技术/研究/数据时，有检索工具才引用可靠来源；',
    '没有检索条件就明确知识时效限制；不编造文献、论文、数据、人物观点或引用；区分事实、推断与假设。'
  ];
  return lines.join('\n');
}
