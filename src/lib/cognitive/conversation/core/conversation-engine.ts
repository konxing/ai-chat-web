import { getConversationStyle } from '../style/style-profile';
import { getActivePromptVersion } from '../prompts/prompt-version';
import { buildConversationPrompt, type BuiltConversationPrompt } from '../prompts/prompt-builder';
import { detectConversationMode, type ModeDetection } from '../mode/mode-detector';
import { modeInstruction } from '../mode/conversation-mode';
import { planResponse, type ResponsePlan } from '../planning/response-planner';
import { selectExamples, renderExamples, selectDialogueExamples, renderDialogueExamples } from '../style/style-examples';
import { renderKnowledgePolicy } from '../knowledge/knowledge-synthesis';
import { understandDialogue, type DialogueUnderstanding } from '../understanding/dialogue-act';
import { buildConversationState, type ConversationState } from '../state/conversation-state';
import { selectResponseAct, ACT_TEXT, type ActSelection } from '../planning/response-act';

/**
 * 对话智能层入口。组合全局原则 + 用户风格 + 生效版本 + 模式(辅助) + 话语行为/交流状态/回应动作。
 * 全规则、零额外模型调用。读失败回落默认，绝不阻断对话。
 */
export interface ConversationIntelligence {
  block: BuiltConversationPrompt;
  style: Awaited<ReturnType<typeof getConversationStyle>>;
  promptVersion: number | null;
  mode: ModeDetection;
  plan: ResponsePlan;
  understanding: DialogueUnderstanding;
  state: ConversationState;
  act: ActSelection;
}

export async function buildConversationIntelligence(input: {
  userId: string;
  currentContent?: string;
  recentDeep?: boolean;
  hasPersonalMemory?: boolean;
  recent?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  providerName?: string;
  /** P4：两臂灰度。legacy=旧规则累加；dialogue-v2=话语行为/状态/回应动作。默认 legacy。 */
  engineVersion?: 'legacy' | 'dialogue-v2';
}): Promise<ConversationIntelligence> {
  const content = input.currentContent ?? '';
  const mode = detectConversationMode({ content, recentDeep: input.recentDeep });
  const understanding = understandDialogue(content);
  const state = buildConversationState(input.recent ?? [], content);
  const act = selectResponseAct(understanding, state);
  const [style, version] = await Promise.all([
    getConversationStyle(input.userId).catch(() => null),
    getActivePromptVersion({ mode: mode.mode, provider: input.providerName }).catch(() => null)
  ]);
  const effectiveStyle = style ?? (await import('../core/conversation-policy')).DEFAULT_CONVERSATION_STYLE;
  const plan = planResponse({
    mode: mode.mode,
    content,
    style: effectiveStyle,
    hasPersonalMemory: input.hasPersonalMemory ?? false
  });
  const modeText = modeInstruction(mode.mode) +
    (mode.secondary ? `\n同时兼顾：${modeInstruction(mode.secondary)}` : '');
  const v2 = (input.engineVersion ?? 'legacy') === 'dialogue-v2';
  // P4 两臂：legacy 用旧规划累加+单轮示例；dialogue-v2 用单一回应动作+多轮示例。
  const actText = v2
    ? `【本轮回应动作】${ACT_TEXT[act.primary]}` + (act.secondary ? `\n次动作：${ACT_TEXT[act.secondary]}` : '')
    : plan.planText;
  const examplesText = v2
    ? ([renderDialogueExamples(selectDialogueExamples(understanding.dialogueAct)), renderExamples(selectExamples(mode.mode, mode.secondary))].filter(Boolean).join('\n') || null)
    : renderExamples(selectExamples(mode.mode, mode.secondary));
  const block = buildConversationPrompt({
    style: effectiveStyle,
    versionContent: version?.content ?? null,
    modeText,
    knowledgeText: renderKnowledgePolicy(mode.mode),
    planText: actText,
    examplesText
  });
  return { block, style: effectiveStyle, promptVersion: version?.version ?? null, mode, plan, understanding, state, act };
}
