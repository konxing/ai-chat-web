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
import { DEFAULT_CONVERSATION_STYLE, type ConversationStyle } from './conversation-policy';
import { getAiReplyPlan, type ReplyPlanningResult } from '../planning/ai-reply-plan';

const PLANNING_HINT_BUDGET = 200;

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
  aiPlanning?: Omit<ReplyPlanningResult, 'hint' | 'outputOnly'>;
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
  if (!rulesBlock.parts.some((part) => part.name === 'plan')) return { ...result, aiPlanning: { status: 'skipped' } };
  const planning = await getAiReplyPlan({
    provider: input.planningProvider,
    currentContent: content,
    recent: input.recent ?? [],
    style: effectiveStyle,
    defaultAction: actText
  });
  const aiPlanning = { status: planning.status, inputTokens: planning.inputTokens, outputTokens: planning.outputTokens };
  if (planning.status !== 'applied') return { ...result, aiPlanning };
  // Give the hint its own budget so it cannot displace existing guidance or examples.
  const hint = '【本轮语境提示】据原话核对本轮范围，契合时据此调整回应动作。\n' +
    JSON.stringify(planning.hint) +
    (planning.outputOnly ? '\n若用户确实只要成品，直接给成品即可，省去说明和额外版本。' : '');
  const text = `${rulesBlock.text}\n\n${hint}`;
  const budget = rulesBlock.budget + PLANNING_HINT_BUDGET;
  if (hint.length + 2 > PLANNING_HINT_BUDGET || text.length > budget) {
    return { ...result, aiPlanning: { ...aiPlanning, status: 'invalid' } };
  }
  const block = {
    ...rulesBlock,
    text,
    budget,
    usedChars: text.length,
    parts: [...rulesBlock.parts, { name: 'reply-planning', chars: hint.length }]
  };
  return { ...result, block, aiPlanning };
}
