import { getConversationStyle } from '../style/style-profile';
import { getActivePromptVersion } from '../prompts/prompt-version';
import { buildConversationPrompt, type BuiltConversationPrompt } from '../prompts/prompt-builder';
import { detectConversationMode, type ModeDetection } from '../mode/mode-detector';
import { modeInstruction } from '../mode/conversation-mode';

/**
 * 对话智能层入口。组合全局原则 + 用户风格 + 生效提示词版本 + 当前交流模式，产出一段 system 块。
 * 模式检测为规则式，不增加模型调用。后续阶段在此接入规划/示例/知识策略。
 *
 * 读失败（配置/版本读不到）时回落默认风格，绝不阻断对话。
 */
export interface ConversationIntelligence {
  block: BuiltConversationPrompt;
  style: Awaited<ReturnType<typeof getConversationStyle>>;
  promptVersion: number | null;
  mode: ModeDetection;
}

export async function buildConversationIntelligence(input: {
  userId: string;
  currentContent?: string;
  recentDeep?: boolean;
}): Promise<ConversationIntelligence> {
  const [style, version] = await Promise.all([
    getConversationStyle(input.userId).catch(() => null),
    getActivePromptVersion().catch(() => null)
  ]);
  const effectiveStyle = style ?? (await import('../core/conversation-policy')).DEFAULT_CONVERSATION_STYLE;
  const mode = detectConversationMode({
    content: input.currentContent ?? '',
    recentDeep: input.recentDeep
  });
  const modeText = modeInstruction(mode.mode) +
    (mode.secondary ? `\n同时兼顾：${modeInstruction(mode.secondary)}` : '');
  const block = buildConversationPrompt({
    style: effectiveStyle,
    versionContent: version?.content ?? null,
    modeText
  });
  return { block, style: effectiveStyle, promptVersion: version?.version ?? null, mode };
}
