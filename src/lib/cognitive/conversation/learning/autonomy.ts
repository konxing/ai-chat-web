/**
 * 自主完成优先的决策接口（v1.3 附录 C3）。纯函数、零模型调用、不存隐私全文（reasonCode 为枚举）。
 *
 * 决策优先级：用户当前明确要求 > 已授权持久偏好 > 近期对话状态 > 低可信历史推断。
 * 风险低、可撤销、已有权限且不缺必要参数 → 默认直接执行（userInterruption=NONE）。
 * 权限不足 → 不假装完成；可一次授权请求或继续不依赖权限的部分。
 * 不为每次低风险决策增加模型调用；沉默≠同意；requireConfirmation/隐私/外部权限不被"低打扰"绕过。
 */

export type AutonomyAction =
  | 'RESPOND' | 'REPAIR_DIALOGUE' | 'UPDATE_SESSION_CONSTRAINT'
  | 'SAVE_EXPLICIT_STYLE' | 'ORGANIZE_MEMORY' | 'BUILD_WIKI_INDEX'
  | 'REQUEST_PERMISSION' | 'ASK_ESSENTIAL';

export type RiskTier = 'LOW_REVERSIBLE' | 'SENSITIVE' | 'EXTERNAL_EFFECT' | 'IRREVERSIBLE';
export type AutonomyScope = 'TURN' | 'TOPIC' | 'SESSION' | 'GLOBAL';
export type Permission = 'ALLOWED' | 'DISABLED' | 'NEEDS_APPROVAL';
export type UserInterruption = 'NONE' | 'ONE_QUESTION' | 'EXPLICIT_APPROVAL';

export interface AutonomyDecision {
  action: AutonomyAction;
  risk: RiskTier;
  scope: AutonomyScope;
  permission: Permission;
  canUndo: boolean;
  userInterruption: UserInterruption;
  /** 精简枚举原因码，不存原始用户隐私全文。 */
  reasonCode: string;
}

/** 表达偏好学习的自主决策（C1/C2/C3）。 */
export function decideStyleAutonomy(input: {
  scope: 'GLOBAL' | 'TASK' | 'CONTEXT' | 'TEMPORARY';
  autoLearnEnabled: boolean;
  isUndo: boolean;
}): AutonomyDecision {
  // 撤销：低风险、可逆、用户当前明确要求 → 直接执行，无需审批。
  if (input.isUndo) {
    return {
      action: 'SAVE_EXPLICIT_STYLE', risk: 'LOW_REVERSIBLE', scope: 'GLOBAL',
      permission: 'ALLOWED', canUndo: true, userInterruption: 'NONE', reasonCode: 'UNDO_EXECUTED'
    };
  }
  // 临时/任务/上下文：本轮/本任务生效，不持久化、不打断。
  if (input.scope !== 'GLOBAL') {
    return {
      action: 'UPDATE_SESSION_CONSTRAINT', risk: 'LOW_REVERSIBLE',
      scope: input.scope === 'TEMPORARY' ? 'TURN' : input.scope === 'TASK' ? 'TOPIC' : 'SESSION',
      permission: 'ALLOWED', canUndo: true, userInterruption: 'NONE', reasonCode: 'SESSION_ONLY_NO_PERSIST'
    };
  }
  // 明确长期 + 已授权自动学习 → 直接保存并可撤销。
  if (input.autoLearnEnabled) {
    return {
      action: 'SAVE_EXPLICIT_STYLE', risk: 'LOW_REVERSIBLE', scope: 'GLOBAL',
      permission: 'ALLOWED', canUndo: true, userInterruption: 'NONE', reasonCode: 'AUTO_SAVE_AUTHORIZED'
    };
  }
  // 未授权：仅当前会话遵守，不写长期库、不反复征求许可（不弹窗）。
  return {
    action: 'UPDATE_SESSION_CONSTRAINT', risk: 'LOW_REVERSIBLE', scope: 'SESSION',
    permission: 'DISABLED', canUndo: true, userInterruption: 'NONE', reasonCode: 'SESSION_ONLY_NO_AUTH'
  };
}