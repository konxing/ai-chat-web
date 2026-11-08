import type { ConversationStyle } from '../core/conversation-policy';
import { setConversationStyle } from '../style/style-profile';

/**
 * 自适应对话学习（Phase 6）。只识别用户对"表达方式"的明确反馈，生成偏好候选。
 *
 * 边界（计划书 8.4/8.6）：
 * - 仅明确反馈（"讲得太复杂/以后…/不要每次列点/主动指出我的错误"）才生成候选；
 *   不凭聊天次数/停留/点赞/是否继续提问推断长期偏好。
 * - 区分 GLOBAL（以后/总是）与 TEMPORARY（这次/先）：临时要求只对本轮生效，不持久化。
 * - 偏好只调整表达维度，不覆盖事实正确性/安全/独立判断（proactivity 调高=更敢指出错误，不是无条件赞同）。
 *
 * 规则式提取，不增加模型调用。
 */

export type PreferenceScope = 'GLOBAL' | 'TASK' | 'CONTEXT' | 'TEMPORARY';

export interface StyleFeedback {
  scope: PreferenceScope;
  adjustments: Partial<ConversationStyle>;
  /** 任务/上下文偏好的适用关键词（TASK/CONTEXT 时用）。 */
  topic?: string;
}

interface FeedbackRule {
  re: RegExp;
  scope: PreferenceScope;
  adjustments: Partial<ConversationStyle>;
  topic?: string;
}

const RULES: FeedbackRule[] = [
  { re: /太复杂|讲简单|简单一点|别展开|不用展开|结论就行|先给结论/, scope: 'TEMPORARY', adjustments: { knowledgeDepth: 'low', length: 'short' } },
  { re: /以后.*简单|总是.*简单|一直.*简短/, scope: 'GLOBAL', adjustments: { length: 'short' } },
  { re: /深入一点|深度一点|展开讲|详细一点/, scope: 'TEMPORARY', adjustments: { knowledgeDepth: 'high', length: 'long' } },
  { re: /以后.*深入|以后.*解释底层|技术问题.*底层原理/, scope: 'GLOBAL', adjustments: { knowledgeDepth: 'high' }, topic: '技术' },
  { re: /不要.*列.*点|别列点|不要.*列表|少用列表/, scope: 'GLOBAL', adjustments: { structure: 'minimal' } },
  { re: /这次.*不要列点|先别列点/, scope: 'TEMPORARY', adjustments: { structure: 'minimal' } },
  { re: /主动指出.*错误|指出我的问题|别光赞同|不要一味附和/, scope: 'GLOBAL', adjustments: { proactivity: 'high' } },
  { re: /多夸夸|亲切一点/, scope: 'GLOBAL', adjustments: { restraint: 'medium' } },
  { re: /以后.*数学.*循序渐进|学数学.*一步步/, scope: 'TASK', adjustments: { structure: 'dynamic' }, topic: '数学' }
];

export function extractStyleFeedback(content: string): StyleFeedback | null {
  for (const rule of RULES) {
    if (rule.re.test(content)) {
      return { scope: rule.scope, adjustments: rule.adjustments, topic: rule.topic };
    }
  }
  return null;
}

/**
 * 应用反馈：GLOBAL 持久化到用户风格；TASK/CONTEXT/TEMPORARY 不写库（本轮/本任务生效由调用方处理）。
 * 返回是否持久化。读/写失败静默，不影响对话。
 */
export async function learnConversationPreference(userId: string, content: string): Promise<boolean> {
  const feedback = extractStyleFeedback(content);
  if (!feedback || feedback.scope !== 'GLOBAL') return false;
  try {
    await setConversationStyle(userId, feedback.adjustments);
    return true;
  } catch {
    return false;
  }
}
