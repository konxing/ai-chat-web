import { getConversationStyle } from '../style/style-profile';
import { getActivePromptVersion } from '../prompts/prompt-version';
import { buildConversationPrompt, type BuiltConversationPrompt } from '../prompts/prompt-builder';

/**
 * 对话智能层入口（Phase 1）。组合全局原则 + 用户风格 + 生效提示词版本，产出一段 system 块。
 * 后续阶段在此接入模式检测/规划/示例/知识策略；默认不增加模型调用。
 *
 * 读失败（配置/版本读不到）时回落默认风格，绝不阻断对话。
 */
export interface ConversationIntelligence {
  block: BuiltConversationPrompt;
  style: Awaited<ReturnType<typeof getConversationStyle>>;
  promptVersion: number | null;
}

export async function buildConversationIntelligence(input: {
  userId: string;
}): Promise<ConversationIntelligence> {
  const [style, version] = await Promise.all([
    getConversationStyle(input.userId).catch(() => null),
    getActivePromptVersion().catch(() => null)
  ]);
  const effectiveStyle = style ?? (await import('../core/conversation-policy')).DEFAULT_CONVERSATION_STYLE;
  const block = buildConversationPrompt({
    style: effectiveStyle,
    versionContent: version?.content ?? null
  });
  return { block, style: effectiveStyle, promptVersion: version?.version ?? null };
}
