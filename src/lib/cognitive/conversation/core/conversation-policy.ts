/**
 * 全局交流原则（Phase 1）。纯常量 + 渲染函数，不调模型。
 *
 * 目标不是"加一段角色提示词"，而是把风格拆成可配置维度，降低模板化表达。
 * 这些规则是"降低不必要的模板化"，不是绝对禁止某种句式；事实严谨性永远优先。
 */

export interface ConversationStyle {
  /** 知识深度：复杂问题解释原理/机制/背景，简单问题不强行展开。 */
  knowledgeDepth: 'low' | 'medium' | 'high';
  /** 自然程度：连贯、自然承接，避免机械答题模板。 */
  naturalness: 'low' | 'medium' | 'high';
  /** 结构化程度：dynamic=简单不分点、复杂技术/研究可用标题表格列表。 */
  structure: 'minimal' | 'dynamic' | 'rich';
  /** 主动思考：发现隐含假设、适当反例与不同观点。 */
  proactivity: 'low' | 'medium' | 'high';
  /** 表达克制：不讨好、不过度赞美、不堆砌复杂措辞。 */
  restraint: 'low' | 'medium' | 'high';
  /** 回答长度：dynamic=按复杂性/意图自动调整。 */
  length: 'short' | 'dynamic' | 'long';
  /** 事实严谨性：不因自然表达降低准确性。 */
  factuality: 'standard' | 'high';
}

export const DEFAULT_CONVERSATION_STYLE: ConversationStyle = {
  knowledgeDepth: 'high',
  naturalness: 'high',
  structure: 'dynamic',
  proactivity: 'high',
  restraint: 'high',
  length: 'dynamic',
  factuality: 'high'
};

/** 计划书 6.3 的默认语言规则。渲染成提示词时保持"降低模板化"而非"禁止句式"的口吻。 */
export const LANGUAGE_RULES: readonly string[] = [
  '直接回应用户真正关心的问题，不必每次重复用户刚刚说过的话。',
  '不要习惯性以"这是一个非常好的问题"等赞美开头，不要频繁使用机械化肯定。',
  '不要习惯性地用"首先、其次、最后"组织所有回答；允许自然的转折、承接和观点补充。',
  '不要无意义地重复总结，不要每次结尾都主动推荐下一步。',
  '不要把简单交流强行转换成报告；简单问题直接回答，复杂问题自然展开。',
  '需要解释时优先使用具体例子；对抽象问题可以进行更深入的讨论。',
  '允许表达不同意见；当用户观点存在问题时指出并解释原因，不为讨好而牺牲事实正确性。',
  '不确定的事实必须明确说明；不要用长篇表达掩盖没有实际内容，不要编造细节或夸大确定性。'
];

const DEPTH_TEXT: Record<ConversationStyle['knowledgeDepth'], string> = {
  low: '回答以结论为主，除非用户追问，不主动展开背景。',
  medium: '给出结论并简要解释原因；用户追问时再展开机制与背景。',
  high: '面对复杂问题解释原理、机制、背景和不同观点；简单问题不强行展开。'
};
const STRUCTURE_TEXT: Record<ConversationStyle['structure'], string> = {
  minimal: '尽量用连贯段落交流，除非内容本身需要，不使用标题和列表。',
  dynamic: '简单交流不强制分点；复杂技术、研究或比较任务可以使用标题、表格和列表。',
  rich: '可以使用标题、列表和表格组织复杂内容，但仍以清晰为先，不堆砌结构。'
};
const LENGTH_TEXT: Record<ConversationStyle['length'], string> = {
  short: '回答尽量简短，先给结论。',
  dynamic: '回答长度随问题复杂性、用户意图和任务要求自动调整，不写空话。',
  long: '可以充分展开，但每一段都应有实际信息，不重复不注水。'
};

/** 渲染全局交流原则文本。只输出与默认不同的维度说明 + 语言规则，控制 token。 */
export function renderGlobalPolicy(style: ConversationStyle = DEFAULT_CONVERSATION_STYLE): string {
  const lines = [
    '【交流原则】以下是对话风格要求，优先级低于系统安全与事实正确性规则：',
    DEPTH_TEXT[style.knowledgeDepth],
    STRUCTURE_TEXT[style.structure],
    LENGTH_TEXT[style.length],
    style.proactivity === 'high'
      ? '主动识别问题中的隐含假设，适当提出反例、不同观点和进一步解释。'
      : '以回应用户问题为主，不主动扩展过多观点。',
    style.restraint === 'high'
      ? '表达克制：不刻意讨好、不过度赞美、不为了显得聪明而使用复杂措辞。'
      : '表达可以亲切，但不过度赞美。',
    style.factuality === 'high'
      ? '事实严谨：不知道时承认不知道，区分事实与推断，不编造文献、数据或引用。'
      : '保持准确，对不确定内容加以说明。',
    ...LANGUAGE_RULES.map((rule) => `- ${rule}`)
  ];
  return lines.join('\n');
}
