import type { DialogueAct } from '../understanding/dialogue-act';

/**
 * 统一对话账本（v1.3 附录 B1/B3 + A.4）。三类账本共用一个 DialogueState，不各自重复保存状态。
 *
 * 设计约束（任务书 B.3/B.5）：
 * - 全部从最近 ≤6 轮真实消息**现场重建**，不写长期记忆、不建新表、零额外模型调用。
 * - 硬约束只能来自用户直接话语（本模块只解析 role:'user' 文本）；Wiki/记忆摘要不能伪装成高优先指令。
 * - 每条记录有来源 turn、生效范围、TTL/状态；纠正分"真纠正"与"正常追问"，不把"再深入点"记成失败。
 * - 状态权限低于 System Rules，视为不可信对话资料；不跨用户共享。
 */

export type Msg = { role: 'user' | 'assistant'; content: string };

// ── B1：修复账本 ─────────────────────────────────────────────
export type RepairType = 'INTENT' | 'FACT' | 'SCOPE' | 'STYLE' | 'TOPIC';

export interface RepairLedgerEntry {
  type: RepairType;
  /** 对助手上轮行为的简短陈述，不造用户心理标签。 */
  mistakenInterpretation?: string;
  /** 用户明确表达的有效修正（限长）。 */
  userCorrection: string;
  /** 下一步应该怎么回应。 */
  correctedExpectation: string;
  sourceTurnIndex: number;
  /** 有限轮数 TTL：超过即失效，或被后续明确修正覆盖。 */
  activeUntilTurn: number;
  confidence: 'explicit' | 'ambiguous';
}

/** 修复账本默认存活轮数（含当前轮）。初始实验参数，非固定定律。 */
export const REPAIR_TTL_TURNS = 3;
const CORRECTION_MAX_CHARS = 120;

// 明确纠正信号（真纠正）。
const EXPLICIT_CORRECT_RE =
  /不是这个意思|你理解错了|你误会了|我没问这个|我不是让你|我不是来|不要继续|不要给方案|我只是想聊聊|我刚才说的是|你说错了|搞错了/;
// 正常追加/深入（不是失败，不记修复账本）。
const NORMAL_FOLLOWUP_RE = /^(再深入|再说说|继续|展开|详细|还有呢|然后呢|接着说)/;
const STYLE_CORRECT_RE = /太机械|别这么官方|不要列点|别列点|太长了|简短些|别这么啰嗦/;
const FACT_CORRECT_RE = /事实不对|数据错了|不是 \d|年份不对|你记错了|实际上不是/;
const TOPIC_CORRECT_RE = /换个话题|不说这个|聊点别的|换一个问题/;

export interface RepairClassification {
  isRepair: boolean;
  type: RepairType;
  confidence: 'explicit' | 'ambiguous';
  correctedExpectation: string;
}

/** 区分真纠正与正常追问；"再深入点"不记为 AI 失败（B1 验收）。 */
export function classifyRepair(text: string): RepairClassification {
  const t = text.trim();
  if (NORMAL_FOLLOWUP_RE.test(t) && !EXPLICIT_CORRECT_RE.test(t)) {
    return { isRepair: false, type: 'INTENT', confidence: 'explicit', correctedExpectation: '' };
  }
  if (TOPIC_CORRECT_RE.test(t)) {
    return { isRepair: true, type: 'TOPIC', confidence: 'explicit', correctedExpectation: '尊重话题转移，不强行拉回原话题。' };
  }
  if (FACT_CORRECT_RE.test(t)) {
    return { isRepair: true, type: 'FACT', confidence: 'explicit', correctedExpectation: '采用用户更正的事实，不再沿用旧错误数据。' };
  }
  if (STYLE_CORRECT_RE.test(t) && !/不是这个意思|你理解错了/.test(t)) {
    return { isRepair: true, type: 'STYLE', confidence: 'explicit', correctedExpectation: '按用户反馈调整表达方式，本轮即生效。' };
  }
  if (EXPLICIT_CORRECT_RE.test(t)) {
    const wantsChat = /只是想聊聊|不是来排查|不要给方案|不想听方案/.test(t);
    return {
      isRepair: true,
      type: 'INTENT',
      confidence: 'explicit',
      correctedExpectation: wantsChat
        ? '以自然聊天承接，不再推送排障步骤或方案；除非用户明确要求排查。'
        : '准确承接被纠正的内容并调整下一步，不重复原错误路径，不固定道歉模板。'
    };
  }
  // 含糊的"不是/不对"开头：低置信，仅本轮参考，不固化失败标签。
  if (/^不是[，,]|^不对[，,]/.test(t)) {
    return { isRepair: true, type: 'INTENT', confidence: 'ambiguous', correctedExpectation: '先确认用户真实意图，再回应。' };
  }
  return { isRepair: false, type: 'INTENT', confidence: 'explicit', correctedExpectation: '' };
}

/** 从最近窗口 + 当前消息重建修复账本，只返回仍在 TTL 内的条目。 */
export function buildRepairLedger(recent: readonly Msg[], currentContent: string): RepairLedgerEntry[] {
  const entries: RepairLedgerEntry[] = [];
  const currentTurnIndex = recent.length; // 当前用户消息在序列中的位置
  recent.forEach((m, i) => {
    if (m.role !== 'user') return;
    const c = classifyRepair(m.content);
    if (!c.isRepair) return;
    entries.push({
      type: c.type,
      userCorrection: m.content.slice(0, CORRECTION_MAX_CHARS),
      correctedExpectation: c.correctedExpectation,
      sourceTurnIndex: i,
      activeUntilTurn: i + REPAIR_TTL_TURNS,
      confidence: c.confidence
    });
  });
  const cur = classifyRepair(currentContent);
  if (cur.isRepair) {
    entries.push({
      type: cur.type,
      userCorrection: currentContent.slice(0, CORRECTION_MAX_CHARS),
      correctedExpectation: cur.correctedExpectation,
      sourceTurnIndex: currentTurnIndex,
      activeUntilTurn: currentTurnIndex + REPAIR_TTL_TURNS,
      confidence: cur.confidence
    });
  }
  // 后出现的明确修正覆盖先前同类含糊修正；只保留活跃条目。
  const active = entries.filter((e) => currentTurnIndex <= e.activeUntilTurn);
  const byType = new Map<RepairType, RepairLedgerEntry>();
  for (const e of active) {
    const prev = byType.get(e.type);
    if (!prev || e.sourceTurnIndex >= prev.sourceTurnIndex) byType.set(e.type, e);
  }
  return [...byType.values()].sort((a, b) => a.sourceTurnIndex - b.sourceTurnIndex);
}

/** 当前轮自身是否是一次明确纠正（供回应动作立即修复）。 */
export function currentRepairEntry(ledger: readonly RepairLedgerEntry[], recentLen: number): RepairLedgerEntry | null {
  return ledger.find((e) => e.sourceTurnIndex === recentLen) ?? null;
}

// ── B3：意图与约束账本 ───────────────────────────────────────
export type ConstraintScope = 'THIS_TURN' | 'THIS_TOPIC' | 'THIS_SESSION' | 'GLOBAL_CONFIRMED';

export interface ActiveConstraint {
  id: string;
  content: string;
  sourceTurnIndex: number;
  scope: ConstraintScope;
  priority: 'explicit_user' | 'inferred_hint';
  state: 'active' | 'revised' | 'expired';
  supersedes?: string;
}

const CONSTRAINT_MAX_CHARS = 100;
// 用户直接的格式/范围硬约束（只从用户话语提取）。
const CONSTRAINT_PATTERNS: Array<{ re: RegExp; content: string }> = [
  { re: /不要列点|别列点|不要列表|少用列表/, content: '不使用列表/分点' },
  { re: /只讨论原理|只讲原理|先讲原理/, content: '优先讨论原理' },
  { re: /不要长篇|别长篇|不要长篇分析|这次不要分析/, content: '本轮不做长篇分析' },
  { re: /简短些|简短一点|简单点|结论就行|先给结论/, content: '回答简短、先给结论' },
  { re: /不要用外部|不使用外部 ?API|别联网/, content: '不使用外部 API/联网' },
  { re: /用中文回答|用英文回答/, content: '指定回答语言' }
];
const TEMP_SCOPE_RE = /这次|本轮|当前|先别|先给/;
const DURABLE_SCOPE_RE = /以后|一直|总是|长期|每次都/;
const TOPIC_SCOPE_RE = /技术问题|数学|编程|这类问题/;
// 撤销/改口：结束旧约束。明确撤销（含全局）与单纯换话题（保留全局明确要求）分开。
const EXPLICIT_REVOKE_RE = /撤销|恢复原来的|恢复默认|还是原来|取消刚才/;
const TOPIC_SWITCH_RE = /换个话题|刚才那个不用|不说这个|聊点别的/;

/** 从最近窗口 + 当前消息重建约束账本，处理改口/撤销/过期。 */
export function buildActiveConstraints(recent: readonly Msg[], currentContent: string): ActiveConstraint[] {
  const currentTurnIndex = recent.length;
  const raw: ActiveConstraint[] = [];
  // 按原始序列索引定位每条用户消息（当前消息位于 recent.length）。
  const indexed: Array<{ text: string; idx: number }> = [];
  recent.forEach((m, i) => { if (m.role === 'user') indexed.push({ text: m.content, idx: i }); });
  indexed.push({ text: currentContent, idx: currentTurnIndex });

  let seq = 0;
  for (const { text, idx } of indexed) {
    if (EXPLICIT_REVOKE_RE.test(text)) {
      // 明确撤销：先前所有活跃约束（含全局）在本会话状态中失效；持久化逆操作由偏好层另行执行。
      for (const c of raw) c.state = 'revised';
      continue;
    }
    if (TOPIC_SWITCH_RE.test(text)) {
      // 单纯换话题：结束旧话题/会话约束，但保留仍有效的全局明确要求（B3）。
      for (const c of raw) if (c.scope !== 'GLOBAL_CONFIRMED') c.state = 'revised';
      continue;
    }
    for (const p of CONSTRAINT_PATTERNS) {
      if (!p.re.test(text)) continue;
      const scope: ConstraintScope = TEMP_SCOPE_RE.test(text)
        ? 'THIS_TURN'
        : DURABLE_SCOPE_RE.test(text)
          ? 'GLOBAL_CONFIRMED'
          : TOPIC_SCOPE_RE.test(text)
            ? 'THIS_TOPIC'
            : 'THIS_SESSION';
      const id = `c${seq++}`;
      // 同内容的新约束取代旧约束。
      const prior = raw.find((c) => c.content === p.content && c.state === 'active');
      if (prior) prior.state = 'revised';
      raw.push({
        id,
        content: p.content.slice(0, CONSTRAINT_MAX_CHARS),
        sourceTurnIndex: idx,
        scope,
        priority: 'explicit_user',
        state: 'active',
        supersedes: prior?.id
      });
    }
  }
  // THIS_TURN 只在当前轮有效：来源不是当前轮则过期。
  for (const c of raw) {
    if (c.scope === 'THIS_TURN' && c.sourceTurnIndex !== currentTurnIndex) c.state = 'expired';
  }
  return raw.filter((c) => c.state === 'active');
}

export interface ConversationalIntent {
  goal: 'discuss' | 'solve' | 'practice' | 'share' | 'unknown';
  currentDialogueAct: DialogueAct;
  unresolvedPoints: string[];
  confidence: 'high' | 'medium' | 'low';
}

const GOAL_BY_ACT: Partial<Record<DialogueAct, ConversationalIntent['goal']>> = {
  ASK_FACT: 'solve', ASK_EXPLANATION: 'practice', ASK_ADVICE: 'solve',
  SHARE_EXPERIENCE: 'share', SHARE_PROGRESS: 'share', VENT: 'share',
  EXPLORE_OPINION: 'discuss', CHALLENGE: 'discuss', CORRECT_ASSISTANT: 'discuss'
};

export function buildIntent(act: DialogueAct, confidence: 'high' | 'medium' | 'low', openLoop: string | null): ConversationalIntent {
  return {
    goal: GOAL_BY_ACT[act] ?? 'unknown',
    currentDialogueAct: act,
    unresolvedPoints: openLoop ? [openLoop.slice(0, CONSTRAINT_MAX_CHARS)] : [],
    confidence
  };
}

// ── A.4：话题栈 ──────────────────────────────────────────────
export interface TopicFrame {
  key: string;
  status: 'active' | 'paused' | 'closed';
}

/** 从最近用户消息的话题域序列建栈；明确换话题则关闭旧话题，不强行拉回。 */
export function buildTopicStack(recent: readonly Msg[], currentDomain: string, currentContent: string): TopicFrame[] {
  const domains: string[] = [];
  for (const m of recent) {
    if (m.role !== 'user') continue;
    const d = domainOf(m.content);
    if (d !== 'general' && domains[domains.length - 1] !== d) domains.push(d);
  }
  const switchTopic = /换个话题|不说这个|聊点别的|换一个问题/.test(currentContent);
  const stack: TopicFrame[] = domains.map((key) => ({ key, status: 'paused' as const }));
  if (switchTopic && stack.length > 0) stack[stack.length - 1].status = 'closed';
  if (currentDomain !== 'general') {
    const existing = stack.find((f) => f.key === currentDomain && f.status !== 'closed');
    if (existing) existing.status = 'active';
    else stack.push({ key: currentDomain, status: 'active' });
  }
  return stack.slice(-4);
}

// 轻量话题域推断（与 dialogue-act.detectTopicDomain 同口径，避免循环依赖只取关键词）。
function domainOf(text: string): string {
  if (/内核|驱动|代码|函数|算法|数据库|架构|网络|协议|容器|Bug|日志|接口|缓存/.test(text)) return 'technical';
  if (/数学|导数|积分|方程|考试|复习|学习|递归|闭包/.test(text)) return 'learning';
  if (/工作|领导|同事|项目|上班|创业/.test(text)) return 'work';
  if (/周末|搬家|睡眠|吃饭|出去/.test(text)) return 'life';
  return 'general';
}