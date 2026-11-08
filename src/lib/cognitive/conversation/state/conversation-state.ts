import type { ResponseAct } from '../planning/response-act';

/**
 * 短生命周期交流状态（P1，修复 F-06）。只从最近 ≤6 轮真实消息构建，不写入永久画像。
 * 记录话题/前轮问题/未解决点/上次回应动作/纠错状态，供规划器选择"适合此刻的一步"。
 */

export interface ConversationState {
  topic: string | null;
  priorQuestion: string | null;
  openLoop: string | null;
  lastAssistantAct: ResponseAct | null;
  recentCorrection: boolean;
  intentConfidence: 'low' | 'medium' | 'high';
}

export const STATE_WINDOW_TURNS = 6;

type Msg = { role: 'user' | 'assistant'; content: string };

export function buildConversationState(recent: readonly Msg[], currentContent: string): ConversationState {
  const window = recent.slice(-STATE_WINDOW_TURNS);
  const lastAssistant = [...window].reverse().find((m) => m.role === 'assistant');
  const lastUserBefore = [...window].reverse().find((m) => m.role === 'user');

  const assistantAsked = lastAssistant ? /[？?]\s*$/.test(lastAssistant.content.trim()) : false;
  // 上轮助手提问但用户本轮没直接回答 → 开放_loop。
  const openLoop = assistantAsked && lastAssistant ? lastAssistant.content : null;

  const recentCorrection = /不是这个意思|你理解错了|我只是想聊聊|不要给方案|不是，/.test(currentContent);

  return {
    topic: lastUserBefore?.content ?? null,
    priorQuestion: assistantAsked ? lastAssistant!.content : null,
    openLoop,
    lastAssistantAct: null, // 由规划器在上一轮写入；此处仅从历史推断纠错/开放环
    recentCorrection,
    intentConfidence: recentCorrection ? 'high' : 'medium'
  };
}
