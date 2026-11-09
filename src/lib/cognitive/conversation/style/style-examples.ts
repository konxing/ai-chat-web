import type { ConversationMode } from '../mode/conversation-mode';
import type { DialogueAct } from '../understanding/dialogue-act';

/**
 * 示例对话库（Phase 4，借鉴 SillyTavern Example Dialogues）。
 *
 * 少量高质量示例，按模式保存；每轮只注入当前模式最相关的 1-2 条，控制 token。
 * 示例用于"展示"期望的表达（自然承接/解释/反例/例子/篇幅/不确定性），不是告诉模型规则。
 * 示例经过人工审核口径编写：不编造事实、不模板化、不讨好。EXAMPLES_VERSION 用于版本管理。
 */

export const EXAMPLES_VERSION = 1;

export interface StyleExample {
  mode: ConversationMode;
  user: string;
  assistant: string;
}

export const STYLE_EXAMPLES: readonly StyleExample[] = [
  {
    mode: 'NATURAL_CHAT',
    user: '今天总算把那个拖了很久的报告写完了。',
    assistant: '拖了这么久终于收尾，松了口气吧。是内容难写，还是一直没整块时间？'
  },
  {
    mode: 'NATURAL_CHAT',
    user: '周末想出去走走，又不知道去哪。',
    assistant: '想安静点还是热闹点？安静就去城郊步道，热闹可以逛市集。你更想哪种？'
  },
  {
    mode: 'DEEP_DISCUSSION',
    user: '为什么现在的人越来越难集中注意力？',
    assistant:
      '一个常见解释是信息供给变了：碎片内容把"切换"训练成了默认动作，深度阅读反而成了要刻意维持的状态。' +
      '但这不是唯一解释，睡眠和压力同样影响注意力。与其归因于意志力，不如先看环境给了多少打断。'
  },
  {
    mode: 'TUTOR',
    user: '导数到底是什么，别给我背定义。',
    assistant:
      '把导数想成"瞬时变化率"。平均速度是总路程除总时间，导数就是把时间窗口缩到极小时的速度。' +
      '比如位置函数在某点的导数，就是那一刻的速度。先有这个直觉，再看极限定义就顺了。'
  },
  {
    mode: 'THINKING_PARTNER',
    user: '我觉得只要换个城市，我的状态就会好起来。',
    assistant:
      '换环境确实能带来新鲜感，但值得先问一句：现在的状态里，有多少是城市造成的，有多少是作息或工作本身？' +
      '如果后者占大头，换城市可能只是把问题搬过去。可以先列两栏看看。'
  },
  {
    mode: 'TECHNICAL_EXPERT',
    user: '容器里网络不通，怎么查？',
    assistant:
      '先分层：容器内 loopback 和 eth0 是否 up，再查 veth/bridge 是否接好，然后看 iptables/nftables 有没有 DROP，' +
      '最后确认路由和 DNS。理论上都通不代表实际通，逐层用 ping/ip route 验证比直接改配置快。'
  },
  {
    mode: 'RESEARCH',
    user: '这个新框架值得在生产用吗？',
    assistant:
      '目前公开证据还少：基准多来自作者自测，缺少独立复现和长期维护记录。我可以给出它的设计取舍，' +
      '但"值得生产用"需要看你的场景和可承受风险。建议先在小范围验证，别直接全量。'
  },
  {
    mode: 'EMOTIONAL',
    user: '最近总觉得很累，做什么都提不起劲。',
    assistant: '听起来这段时间消耗挺大的。愿意说说是什么在持续耗着你吗？不用急着找办法，先把它讲出来就好。'
  },
  {
    mode: 'CREATIVE',
    user: '想做一个帮人整理思路的小工具，有什么方向？',
    assistant:
      '可以往"把混乱输入变成结构"走：语音倒想法→自动归类→生成下一步。另一个方向是"追问式"，工具不断问为什么帮你澄清。' +
      '前者省力度，后者深度好。先做哪个取决于你想解决"懒"还是"乱"。'
  }
];

/** 每轮只取当前模式（+secondary）的示例，最多 2 条，控制 token。 */
export function selectExamples(mode: ConversationMode, secondary?: ConversationMode | null): StyleExample[] {
  const primary = STYLE_EXAMPLES.filter((e) => e.mode === mode);
  const extra = secondary ? STYLE_EXAMPLES.filter((e) => e.mode === secondary) : [];
  return [...primary, ...extra].slice(0, 2);
}

export function renderExamples(examples: readonly StyleExample[]): string | null {
  if (examples.length === 0) return null;
  const lines = ['【表达示例·仅示范风格，不要照抄内容】'];
  for (const e of examples) {
    lines.push(`用户：${e.user}\n助手：${e.assistant}`);
  }
  return lines.join('\n');
}

/**
 * P2：3-5 轮短真实结构模拟示例，覆盖纠正/话题转折/分享进展/分歧/不愿被指导。
 * 示例不得冒充用户实际历史；每轮只选与当前话语行为接近的 0-2 组，限制 token。
 */
export interface DialogueExample {
  id: string;
  acts: DialogueAct[];
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export const DIALOGUE_EXAMPLES: readonly DialogueExample[] = [
  { id: 'd1', acts: ['SHARE_PROGRESS', 'VENT'], turns: [
    { role: 'user', content: '今天一个 Bug 修了一天还没好。' },
    { role: 'assistant', content: '修一天还没好，挺耗人的。是越查越乱那种吗？' },
    { role: 'user', content: '对，就是越查越乱。' },
    { role: 'assistant', content: '那先停一下也行。想捋的时候我陪你。' } ] },
  { id: 'd2', acts: ['CORRECT_ASSISTANT'], turns: [
    { role: 'user', content: '最近状态不好。' },
    { role: 'assistant', content: '我给你几个调整建议吧。' },
    { role: 'user', content: '不是，我只是想聊聊，不要给方案。' },
    { role: 'assistant', content: '好，不给方案。你想从哪说起？' } ] },
  { id: 'd3', acts: ['EXPLORE_OPINION', 'CHALLENGE'], turns: [
    { role: 'user', content: '我觉得学习已经没用了。' },
    { role: 'assistant', content: '听起来你对"学了没用上"很失望。是最近有什么让你这么觉得？' },
    { role: 'user', content: '学了那么多，工作还是那样。' },
    { role: 'assistant', content: '短期看不到回报确实磨人。不过"没用"和"还没用上"是两回事。' } ] },
  { id: 'd4', acts: ['ASK_EXPLANATION'], turns: [
    { role: 'user', content: '这个 Bug 为什么复现不了？' },
    { role: 'assistant', content: '复现不了通常是环境或时序差异。先对比触发时的输入和状态。' },
    { role: 'user', content: '日志显示 KNET 没收到包。' },
    { role: 'assistant', content: '那先抓包确认网卡有没有包，再往协议栈上层查。' } ] },
  { id: 'd5', acts: ['ACKNOWLEDGE', 'SHARE_EXPERIENCE'], turns: [
    { role: 'user', content: '终于把报告写完了！' },
    { role: 'assistant', content: '恭喜收尾！松了口气吧。' },
    { role: 'user', content: '是啊，拖太久了。' },
    { role: 'assistant', content: '拖久了完成那一刻特别爽。打算歇歇还是继续？' } ] }
];

export function selectDialogueExamples(act: DialogueAct): DialogueExample[] {
  return DIALOGUE_EXAMPLES.filter((e) => e.acts.includes(act)).slice(0, 2);
}

export function renderDialogueExamples(examples: readonly DialogueExample[]): string | null {
  if (examples.length === 0) return null;
  const lines = ['【多轮示例·仅示范承接/纠正/分歧的风格，非用户真实历史】'];
  for (const e of examples) {
    lines.push(e.turns.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n'));
  }
  return lines.join('\n');
}

/**
 * v1.3 A.3：按话语行为选**最多 1 组**短多轮示例，严格字符预算（初始实验参数 200–350）。
 * 预算不足可完全不注入；返回引用诊断（选中/原因/是否裁剪），供匿名结构化审计，不存私人正文。
 * naturalness=low 时不注入示例（低自然度偏直接、信息密度高）。
 */
export const DIALOGUE_EXAMPLE_BUDGET_CHARS = 350;

export interface ExampleDiagnostics {
  selectedId: string | null;
  reason: 'act-match' | 'over-budget' | 'no-match' | 'low-naturalness';
  chars: number;
  trimmed: boolean;
}

function exampleChars(e: DialogueExample): number {
  return e.turns.reduce((s, t) => s + t.content.length + 4, 0); // "用户："/"助手：" 标签各 3-4 字
}

export function selectDialogueExampleFor(
  act: DialogueAct,
  opts: { budget?: number; naturalness?: 'low' | 'medium' | 'high' } = {}
): { example: DialogueExample | null; diagnostics: ExampleDiagnostics } {
  const budget = opts.budget ?? DIALOGUE_EXAMPLE_BUDGET_CHARS;
  if (opts.naturalness === 'low') {
    return { example: null, diagnostics: { selectedId: null, reason: 'low-naturalness', chars: 0, trimmed: false } };
  }
  const candidates = DIALOGUE_EXAMPLES.filter((e) => e.acts.includes(act));
  if (candidates.length === 0) {
    return { example: null, diagnostics: { selectedId: null, reason: 'no-match', chars: 0, trimmed: false } };
  }
  const first = candidates[0];
  const chars = exampleChars(first);
  if (chars <= budget) {
    return { example: first, diagnostics: { selectedId: first.id, reason: 'act-match', chars, trimmed: false } };
  }
  // 超预算：按 A.3 可直接不注入，而不是裁掉用户最新消息/事实依据。
  return { example: null, diagnostics: { selectedId: null, reason: 'over-budget', chars, trimmed: false } };
}
