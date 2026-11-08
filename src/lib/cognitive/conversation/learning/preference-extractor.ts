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
  /** 立场类偏好（主动/克制）本身即长期指令，无需"以后"标记。 */
  durable?: boolean;
}

const RULES: FeedbackRule[] = [
  // P3/F-08：先临时后长期，防止宽泛 GLOBAL 正则遮盖"这次/本轮"临时要求。
  { re: /这次.*不要列点|先别列点|本轮.*简单|当前.*简单/, scope: 'TEMPORARY', adjustments: { structure: 'minimal' } },
  { re: /太复杂|讲简单|简单一点|别展开|不用展开|结论就行|先给结论/, scope: 'TEMPORARY', adjustments: { knowledgeDepth: 'low', length: 'short' } },
  { re: /深入一点|深度一点|展开讲|详细一点/, scope: 'TEMPORARY', adjustments: { knowledgeDepth: 'high', length: 'long' } },
  { re: /以后.*简单|总是.*简单|一直.*简短/, scope: 'GLOBAL', adjustments: { length: 'short' } },
  { re: /以后.*深入|以后.*解释底层|技术问题.*底层原理|以后.*技术.*原理/, scope: 'GLOBAL', adjustments: { knowledgeDepth: 'high' }, topic: '技术' },
  { re: /以后.*不要列点|一直.*别列点|总是.*不要列表/, scope: 'GLOBAL', adjustments: { structure: 'minimal' } },
  { re: /不要.*列.*点|别列点|不要.*列表|少用列表/, scope: 'GLOBAL', adjustments: { structure: 'minimal' } },
  { re: /主动指出.*错误|指出我的问题|别光赞同|不要一味附和/, scope: 'GLOBAL', adjustments: { proactivity: 'high' }, durable: true },
  { re: /多夸夸|亲切一点/, scope: 'GLOBAL', adjustments: { restraint: 'medium' }, durable: true },
  { re: /以后.*数学.*循序渐进|学数学.*一步步/, scope: 'TASK', adjustments: { structure: 'dynamic' }, topic: '数学' }
];

const TEMPORARY_MARKER = /这次|本轮|当前|先给|先别/;
const DURABLE_MARKER = /以后|一直|总是|长期|每次都/;

export function extractStyleFeedback(content: string): StyleFeedback | null {
  // 明确临时标记优先：即使句中含"不要列点"，"这次不要列点"也必须是 TEMPORARY。
  if (TEMPORARY_MARKER.test(content)) {
    for (const rule of RULES) {
      if (rule.scope === 'TEMPORARY' && rule.re.test(content)) {
        return { scope: 'TEMPORARY', adjustments: rule.adjustments, topic: rule.topic };
      }
    }
  }
  for (const rule of RULES) {
    if (rule.re.test(content)) {
      // 无持续标记且非固有长期的 GLOBAL 命中降级为候选（不自动持久化），交由用户确认。
      const scope = rule.scope === 'GLOBAL' && !rule.durable && !DURABLE_MARKER.test(content) ? 'CONTEXT' : rule.scope;
      return { scope, adjustments: rule.adjustments, topic: rule.topic };
    }
  }
  return null;
}

/** P3 反馈归因：用户说"太机械"时区分意图误识/追问过多/密度错配/文风，不统一改 structure。 */
export type MechanicalCause = 'intent' | 'over_question' | 'density' | 'style';
export function attributeMechanicalFeedback(content: string): MechanicalCause {
  if (/理解错|不是这个意思|没懂我/.test(content)) return 'intent';
  if (/别问|问太多|连环问|总问我/.test(content)) return 'over_question';
  if (/太复杂|太长|信息太多|简单点/.test(content)) return 'density';
  return 'style';
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
