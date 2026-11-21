import type { AiProvider } from '@prisma/client';
import { getConversationStyle } from '../style/style-profile';
import { getActivePromptVersion } from '../prompts/prompt-version';
import { buildConversationPrompt, type BuiltConversationPrompt } from '../prompts/prompt-builder';
import { detectConversationMode, type ModeDetection } from '../mode/mode-detector';
import { modeInstruction } from '../mode/conversation-mode';
import { planResponse, type ResponsePlan } from '../planning/response-planner';
import { selectExamples, renderExamples, selectDialogueExampleFor, renderDialogueExamples, type ExampleDiagnostics } from '../style/style-examples';
import { renderKnowledgePolicy } from '../knowledge/knowledge-synthesis';
import { understandDialogue, type DialogueUnderstanding } from '../understanding/dialogue-act';
import { buildConversationState, renderStateBrief, type ConversationState } from '../state/conversation-state';
import { selectResponseAct, ACT_TEXT, type ActSelection } from '../planning/response-act';
import { DEFAULT_CONVERSATION_STYLE, renderGlobalPolicy, renderOptionalStyle, type ConversationStyle } from './conversation-policy';
import { getAiReplyPlan, type ReplyPlanningResult } from '../planning/ai-reply-plan';

/**
 * 对话智能层入口。组合全局原则 + 用户风格 + 生效版本 + 模式(辅助) + 话语行为/交流状态/回应动作。
 * 规则流程提供默认与回退策略；只在启用 AI 规划时发出额外请求。
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
  /** A.3：v2 示例引用诊断（是否选中/原因/字符数/是否裁剪）；legacy 为 null。 */
  exampleDiagnostics: ExampleDiagnostics | null;
  aiPlanning?: Omit<ReplyPlanningResult, 'plan'>;
}

export async function buildConversationIntelligence(input: {
  userId: string;
  style?: ConversationStyle;
  currentContent?: string;
  recentDeep?: boolean;
  hasPersonalMemory?: boolean;
  recent?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  providerName?: string;
  /** P4：两臂灰度。legacy=旧规则累加；dialogue-v2=话语行为/状态/回应动作。默认 legacy。 */
  engineVersion?: 'legacy' | 'dialogue-v2';
  planningProvider?: AiProvider;
}): Promise<ConversationIntelligence> {
  const content = input.currentContent ?? '';
  const mode = detectConversationMode({ content, recentDeep: input.recentDeep });
  const understanding = understandDialogue(content);
  const [style, version] = await Promise.all([
    input.style ?? getConversationStyle(input.userId).catch(() => null),
    getActivePromptVersion({ mode: mode.mode, provider: input.providerName }).catch(() => null)
  ]);
  const effectiveStyle = style ?? DEFAULT_CONVERSATION_STYLE;
  const state = buildConversationState(input.recent ?? [], content, understanding);
  // A.5：naturalness 传入回应动作选择（低自然度=偏直接），不再只是装饰文本。
  const act = selectResponseAct(understanding, state, content, effectiveStyle.naturalness);
  const plan = planResponse({
    mode: mode.mode,
    content,
    style: effectiveStyle,
    hasPersonalMemory: input.hasPersonalMemory ?? false
  });
  const modeText = modeInstruction(mode.mode) +
    (mode.secondary ? `\n同时兼顾：${modeInstruction(mode.secondary)}` : '');
  const v2 = (input.engineVersion ?? 'legacy') === 'dialogue-v2';
  const switchingTopic = state.currentRepair?.type === 'TOPIC';
  // P4 两臂：legacy 用旧规划累加+单轮示例；dialogue-v2 用单一回应动作+多轮示例。
  const actText = v2 || switchingTopic
    ? `【本轮回应动作】${ACT_TEXT[act.primary]}` +
      (act.secondary ? `\n次动作：${ACT_TEXT[act.secondary]}` : '') +
      (act.contextNote ? `\n${act.contextNote}` : '')
    : plan.planText;
  // A.3：v2 每轮最多 1 组多轮示例，按"动作+话题"择优，严格字符预算，带引用诊断；预算不足可完全不注入。
  const picked = v2 && !switchingTopic && act.primary !== 'ASK_ONE_CLARIFICATION'
    ? selectDialogueExampleFor(understanding.dialogueAct, {
        naturalness: effectiveStyle.naturalness,
        recentText: [content, state.topic ?? ''].join(' ')
      })
    : null;
  const exampleDiagnostics: ExampleDiagnostics | null = picked?.diagnostics ?? null;
  const examplesText = switchingTopic ? null : v2
    ? (picked?.example ? renderDialogueExamples([picked.example]) : null)
    : renderExamples(selectExamples(mode.mode, mode.secondary));
  // v1.3：极简对话状态，改善"重复追问/换话题被拉回"；仅 v2 注入。
  const stateText = v2 ? renderStateBrief(state) : null;
  const rulesBlock = buildConversationPrompt({
    style: effectiveStyle,
    versionContent: version?.content ?? null,
    modeText: switchingTopic ? null : modeText,
    knowledgeText: switchingTopic ? null : renderKnowledgePolicy(mode.mode),
    planText: actText,
    stateText,
    examplesText
  });
  const result = { block: rulesBlock, style: effectiveStyle, promptVersion: version?.version ?? null, mode, plan, understanding, state, act, exampleDiagnostics };
  if (!input.planningProvider) return result;
  const planning = await getAiReplyPlan({
    provider: input.planningProvider,
    currentContent: content,
    recent: input.recent ?? [],
    style: effectiveStyle,
    constraints: state.activeConstraints.map((constraint) => constraint.content)
  });
  const aiPlanning = { status: planning.status, inputTokens: planning.inputTokens, outputTokens: planning.outputTokens };
  if (planning.status !== 'applied') return { ...result, aiPlanning };
  const { focus, approach, missing, preferences } = planning.plan;
  // The answer sees the original conversation, and can disregard a bad interpretation.
  const selectedStyle = version?.content?.trim() ? renderOptionalStyle(effectiveStyle, preferences).join('\n') : '';
  const plannedBlock = buildConversationPrompt({
    style: effectiveStyle,
    versionContent: version?.content?.trim() || renderGlobalPolicy(effectiveStyle, preferences),
    planText: [
      '【本轮回应建议】下面是对话规划，仅供参考。以用户原话和确切上下文为准。只有确实缺少关键条件才问。',
      JSON.stringify({ focus, approach, missing }),
      selectedStyle
    ].filter(Boolean).join('\n')
  });
  // A long administrator-authored policy can consume the full prompt budget.
  if (!plannedBlock.parts.some((part) => part.name === 'plan')) {
    return { ...result, aiPlanning: { ...aiPlanning, status: 'invalid' } };
  }
  return { ...result, block: plannedBlock, aiPlanning };
}
