import type { ConversationStyle } from '../core/conversation-policy';
import { setConversationStyle, performStyleUndo, type StyleUndoTarget } from '../style/style-profile';
import { autoLearnStyleEnabled } from '../../cognitive-flags';
import { decideStyleAutonomy } from './autonomy';

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
 * v1.3 C2：自然语言撤销解析（无需按钮）。返回撤销目标；非撤销返回 null。
 * "恢复原来的风格/恢复默认/撤销风格偏好" → 全量恢复；
 * "撤销之前的简短偏好/不要这么简短" → 恢复长度；"撤销不要列点/恢复列表" → 恢复结构。
 */
export function detectStyleUndo(content: string): StyleUndoTarget | null {
  const t = content.trim();
  if (/恢复原来的风格|恢复默认风格|恢复默认|撤销.*风格偏好|撤销之前的偏好|取消.*偏好/.test(t)) return 'full';
  if (/撤销.*简短|不要.*简短|恢复详细|别这么简短|撤销.*简短偏好/.test(t)) return 'length';
  if (/撤销.*列点|恢复列表|撤销.*不列点|可以列点/.test(t)) return 'structure';
  if (/撤销.*深入|恢复深度|别这么浅/.test(t)) return 'depth';
  return null;
}

/**
 * 应用反馈（v1.3 C2/C3 低打扰自主）：
 * - 自然语言撤销优先：低风险可逆，直接执行真正逆操作，无需审批。
 * - GLOBAL 持久化须 autoLearnStyle 已授权；未授权仅当前会话遵守，不写库、不弹窗。
 * - TASK/CONTEXT/TEMPORARY 不写库（本轮/本任务生效由调用方处理）。
 * 返回是否产生持久化变更（持久化或撤销）。读/写失败静默，不影响对话。
 */
export async function learnConversationPreference(userId: string, content: string): Promise<boolean> {
  const undo = detectStyleUndo(content);
  if (undo) {
    const decision = decideStyleAutonomy({ scope: 'GLOBAL', autoLearnEnabled: false, isUndo: true });
    if (decision.permission !== 'ALLOWED') return false;
    try {
      await performStyleUndo(userId, undo);
      return true;
    } catch {
      return false;
    }
  }
  const feedback = extractStyleFeedback(content);
  if (!feedback) return false;
  const autoLearn = await autoLearnStyleEnabled().catch(() => false);
  const decision = decideStyleAutonomy({ scope: feedback.scope, autoLearnEnabled: autoLearn, isUndo: false });
  // 仅 ALLOWED 的 GLOBAL 才持久化；其余本轮遵守但不写库（permission DISABLED/会话级）。
  if (decision.action !== 'SAVE_EXPLICIT_STYLE' || decision.permission !== 'ALLOWED') return false;
  try {
    await setConversationStyle(userId, feedback.adjustments, 'auto');
    return true;
  } catch {
    return false;
  }
}
