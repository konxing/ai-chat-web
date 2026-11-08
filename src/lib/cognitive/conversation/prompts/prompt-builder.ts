import { renderGlobalPolicy, type ConversationStyle } from '../core/conversation-policy';

/**
 * 统一 Prompt Builder（Phase 1）。把散落的风格/模式/示例/策略组合成一段对话智能 system 块。
 *
 * 优先级（高→低）：全局交流原则 > 用户风格 > 模式 > 知识策略 > 规划 > 示例。
 * 低优先级内容在超预算时先被裁剪（示例最先），高优先级的安全/事实规则永不裁剪
 * （它们不在这个块里，而在 base system，见 chats.ts）。
 *
 * 返回各部分字符数供 token 成本统计（近似 1 字符≈0.6 token，中文偏高，仅作预算监控）。
 */

export interface PromptPart {
  name: string;
  text: string;
}

export interface BuiltConversationPrompt {
  text: string;
  parts: { name: string; chars: number }[];
  truncated: boolean;
}

/** 对话智能块字符预算。初始较小，实际由评测调整（计划书 11.3）。 */
export const CONVERSATION_PROMPT_MAX_CHARS = 1600;

export function buildConversationPrompt(input: {
  style: ConversationStyle;
  /** 生效提示词版本的内容；给了就用它代替默认全局原则。 */
  versionContent?: string | null;
  modeText?: string | null;
  knowledgeText?: string | null;
  planText?: string | null;
  examplesText?: string | null;
  maxChars?: number;
}): BuiltConversationPrompt {
  const budget = input.maxChars ?? CONVERSATION_PROMPT_MAX_CHARS;
  // P2/F-07：先决策必要部分再分配预算。优先级：核心原则 > 当轮回应动作 > 少量示例 > 模式/知识(通用)。
  // 超预算时先省略通用重复的模式/知识说明，而非总是裁掉示例。
  const ordered: PromptPart[] = [
    { name: 'global-policy', text: input.versionContent?.trim() || renderGlobalPolicy(input.style) },
    ...(input.planText ? [{ name: 'plan', text: input.planText }] : []),
    ...(input.examplesText ? [{ name: 'examples', text: input.examplesText }] : []),
    ...(input.modeText ? [{ name: 'mode', text: input.modeText }] : []),
    ...(input.knowledgeText ? [{ name: 'knowledge', text: input.knowledgeText }] : [])
  ];

  const kept: PromptPart[] = [];
  let used = 0;
  let truncated = false;
  for (const part of ordered) {
    const cost = part.text.length + 1;
    if (used + cost <= budget) {
      kept.push(part);
      used += cost;
    } else {
      truncated = true;
      // 高优先级（global-policy）必须保留；其余超预算直接丢弃。
      if (part.name === 'global-policy') {
        kept.push({ name: part.name, text: part.text.slice(0, Math.max(0, budget - used)) });
        used = budget;
      }
    }
  }

  return {
    text: kept.map((p) => p.text).join('\n\n'),
    parts: kept.map((p) => ({ name: p.name, chars: p.text.length })),
    truncated
  };
}
