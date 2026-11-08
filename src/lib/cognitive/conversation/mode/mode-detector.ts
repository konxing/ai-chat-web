import type { ConversationMode } from './conversation-mode';

/**
 * 规则式模式检测（Phase 2）。不增加 LLM 调用（计划书 4.3 / 11.1）。
 *
 * 优先级：当前会话的明确要求 > 主题关键词 > 复杂度启发 > 默认 NATURAL_CHAT。
 * 允许多模式共存：返回 primary + secondary（如复杂技术讨论 = TECHNICAL_EXPERT + TUTOR）。
 * 检测只读当前消息与少量上下文标志，不做语义模型调用。
 */

export interface ModeDetection {
  mode: ConversationMode;
  secondary: ConversationMode | null;
  /** 是否来自用户当前明确要求（"简单一点/深入讲讲/像老师一样/不要列点"）。 */
  explicit: boolean;
}

interface ExplicitRule {
  re: RegExp;
  mode: ConversationMode;
}

// 当前会话明确要求优先（计划书 4.4）。顺序即匹配优先级。
const EXPLICIT_RULES: ExplicitRule[] = [
  { re: /像老师|教我|一步步|循序渐进|给我讲懂/, mode: 'TUTOR' },
  { re: /不要列点|别列点|直接交流|自然一点|口语一点/, mode: 'NATURAL_CHAT' },
  { re: /简单一点|简短|结论就行|不用展开/, mode: 'NATURAL_CHAT' },
  { re: /深入|深度|展开讲|详细分析|底层原理/, mode: 'DEEP_DISCUSSION' },
  { re: /帮我理清|我在想|我的假设|你觉得我这个想法/, mode: 'THINKING_PARTNER' },
  { re: /严谨|证据|来源|引用|最新研究|数据支持/, mode: 'RESEARCH' }
];

interface KeywordRule {
  re: RegExp;
  mode: ConversationMode;
  weight: number;
}

const KEYWORD_RULES: KeywordRule[] = [
  { re: /难过|烦|焦虑|压力|开心|失落|委屈|心里|感受|情绪/, mode: 'EMOTIONAL', weight: 3 },
  { re: /数学|积分|导数|方程|证明|考试|复习|这道题|怎么做|编程|代码|函数|算法/, mode: 'TUTOR', weight: 2 },
  { re: /内核|驱动|操作系统|嵌入式|数据库|架构|网络|协议|故障|排查|部署|SONiC|交换机/, mode: 'TECHNICAL_EXPERT', weight: 3 },
  { re: /为什么|机制|本质|哲学|社会|心理|人性|现象|因果|如何看待/, mode: 'DEEP_DISCUSSION', weight: 2 },
  { re: /研究|趋势|行业|最新|报告|对比.*方案|文献|论文/, mode: 'RESEARCH', weight: 2 },
  { re: /创意|构思|设计一个|产品|点子| brainstorm|方案创新|开放/, mode: 'CREATIVE', weight: 2 },
  { re: /我在想|不确定|假设|你觉得.*想法|帮我分析.*思路/, mode: 'THINKING_PARTNER', weight: 2 }
];

export function detectConversationMode(input: {
  content: string;
  /** 最近几轮是否已在深入讨论（用于承接），可选。 */
  recentDeep?: boolean;
}): ModeDetection {
  const text = input.content;

  for (const rule of EXPLICIT_RULES) {
    if (rule.re.test(text)) {
      return { mode: rule.mode, secondary: null, explicit: true };
    }
  }

  const scores = new Map<ConversationMode, number>();
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(text)) scores.set(rule.mode, (scores.get(rule.mode) ?? 0) + rule.weight);
  }

  // 复杂度启发：长消息 + 多问号/多子句 → 倾向深度/研究而非自然闲聊。
  const isLong = text.length > 120;
  const multiPart = (text.match(/[？?；;]/g) ?? []).length >= 2;
  if (isLong && multiPart) {
    scores.set('DEEP_DISCUSSION', (scores.get('DEEP_DISCUSSION') ?? 0) + 1);
  }
  if (input.recentDeep) {
    scores.set('DEEP_DISCUSSION', (scores.get('DEEP_DISCUSSION') ?? 0) + 1);
  }

  if (scores.size === 0) return { mode: 'NATURAL_CHAT', secondary: null, explicit: false };

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sorted[0][0];
  const secondary = sorted[1] && sorted[1][1] >= 2 ? sorted[1][0] : null;
  return { mode: primary, secondary: secondary !== primary ? secondary : null, explicit: false };
}
