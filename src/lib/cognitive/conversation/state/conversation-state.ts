import type { ResponseAct } from '../planning/response-act';
import type { DialogueAct, TopicDomain } from '../understanding/dialogue-act';
import {
  buildRepairLedger, buildActiveConstraints, buildIntent, buildTopicStack, isTopicSwitch,
  type RepairLedgerEntry, type ActiveConstraint, type ConversationalIntent, type TopicFrame
} from './dialogue-ledgers';

/**
 * 短生命周期交流状态（P1 修复 F-06；v1.3 附录 B 统一三账本）。
 * 只从最近 ≤6 轮真实消息现场重建，不写入永久画像、不建新表。
 * repairLedger / activeConstraints / pendingIntent / topicStack 共用这一个状态对象，
 * 避免各模块独立形成互相矛盾的"最新理解"（任务书 B.3）。
 */

export interface ConversationState {
  topic: string | null;
  priorQuestion: string | null;
  openLoop: string | null;
  lastAssistantAct: ResponseAct | null;
  recentCorrection: boolean;
  intentConfidence: 'low' | 'medium' | 'high';
  /** B1：修复账本（真纠正 vs 正常追问已区分，带 TTL）。 */
  repairLedger: RepairLedgerEntry[];
  /** B1：当前轮自身若是一次明确纠正，指向该条目（供立即修复）。 */
  currentRepair: RepairLedgerEntry | null;
  /** B3：仍然有效的用户直接约束（THIS_TURN 不持久化）。 */
  activeConstraints: ActiveConstraint[];
  /** B3：当前意图与未解决点。 */
  pendingIntent: ConversationalIntent;
  /** A.4：话题栈（active/paused/closed）。 */
  topicStack: TopicFrame[];
}

export const STATE_WINDOW_TURNS = 6;

type Msg = { role: 'user' | 'assistant'; content: string };

export function buildConversationState(
  recent: readonly Msg[],
  currentContent: string,
  understanding?: { dialogueAct: DialogueAct; intentConfidence: 'low' | 'medium' | 'high'; topicDomain: TopicDomain }
): ConversationState {
  const window = recent.slice(-STATE_WINDOW_TURNS);
  const latestFirst = [...window].reverse();
  const priorSwitch = latestFirst.findIndex((m) => m.role === 'user' && isTopicSwitch(m.content));
  const topicHistory = isTopicSwitch(currentContent) ? [] : priorSwitch < 0 ? latestFirst : latestFirst.slice(0, priorSwitch + 1);
  const lastAssistant = topicHistory.find((m) => m.role === 'assistant');
  const lastUserBefore = topicHistory.find((m) => m.role === 'user');

  const assistantAsked = lastAssistant ? /[？?]\s*$/.test(lastAssistant.content.trim()) : false;
  const openLoop = assistantAsked && lastAssistant ? lastAssistant.content : null;

  // 账本基于完整 recent（含窗口外索引会失真），故用窗口重建并把当前轮索引对齐到窗口长度。
  const repairLedger = buildRepairLedger(window, currentContent);
  const activeConstraints = buildActiveConstraints(window, currentContent);
  const currentRepair = repairLedger.find((e) => e.sourceTurnIndex === window.length) ?? null;
  const recentCorrection = currentRepair !== null && currentRepair.confidence === 'explicit';

  const act = understanding?.dialogueAct ?? 'UNCLEAR';
  const confidence = understanding?.intentConfidence ?? (recentCorrection ? 'high' : 'medium');
  const domain = understanding?.topicDomain ?? 'general';

  return {
    topic: lastUserBefore?.content ?? null,
    priorQuestion: assistantAsked ? lastAssistant!.content : null,
    openLoop,
    lastAssistantAct: null,
    recentCorrection,
    intentConfidence: recentCorrection ? 'high' : confidence,
    repairLedger,
    currentRepair,
    activeConstraints,
    pendingIntent: buildIntent(act, confidence, openLoop),
    topicStack: buildTopicStack(window, domain, currentContent)
  };
}

const TOPIC_LABEL: Record<string, string> = {
  technical: '技术', learning: '学习', work: '工作', life: '生活', emotion: '情绪', opinion: '观点'
};

/**
 * v1.3：极简对话状态提示（≤~100 字符），只给必要承接信息，不堆状态。
 * 用于 v2 提示词，改善"上一轮问过又问、换话题被拉回"这类连续性问题。
 */
export function renderStateBrief(state: ConversationState): string | null {
  const parts: string[] = [];
  const active = [...state.topicStack].reverse().find((f) => f.status === 'active');
  if (active && TOPIC_LABEL[active.key]) parts.push(`当前话题：${TOPIC_LABEL[active.key]}`);
  if (state.openLoop) parts.push('上一轮你已提问、用户尚未回答：不要重复同一个问题');
  return parts.length ? `【对话状态】${parts.join('；')}。` : null;
}
