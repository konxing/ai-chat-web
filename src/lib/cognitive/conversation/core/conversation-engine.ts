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
}): Promise<ConversationIntelligence> {
  const [style, version] = await Promise.all([
    getConversationStyle(input.userId).catch(() => null),
    getActivePromptVersion().catch(() => null)
  ]);
  const effectiveStyle = style ?? (await import('../core/conversation-policy')).DEFAULT_CONVERSATION_STYLE;
  const content = input.currentContent ?? '';
  const mode = detectConversationMode({ content, recentDeep: input.recentDeep });
  const understanding = understandDialogue(content);
  const state = buildConversationState(input.recent ?? [], content);
  const act = selectResponseAct(understanding, state);
  const plan = planResponse({
    mode: mode.mode,
    content,
    style: effectiveStyle,
    hasPersonalMemory: input.hasPersonalMemory ?? false
  });
  const modeText = modeInstruction(mode.mode) +
    (mode.secondary ? `\n同时兼顾：${modeInstruction(mode.secondary)}` : '');
  // P1：用单一回应动作替代固定累加策略；先承接再展开。
  const actText = `【本轮回应动作】${ACT_TEXT[act.primary]}` +
    (act.secondary ? `\n次动作：${ACT_TEXT[act.secondary]}` : '');
  const examplesText = [
    renderDialogueExamples(selectDialogueExamples(understanding.dialogueAct)),
    renderExamples(selectExamples(mode.mode, mode.secondary))
  ].filter(Boolean).join('\n') || null;
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
