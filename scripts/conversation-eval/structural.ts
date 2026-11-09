/* eslint-disable no-console */
/**
 * 对话智能层 v1.3 结构化评测（附录 B3/C5）。
 *
 * 零模型调用、零数据库：直接跑纯规则链（话语行为→统一账本→回应动作→追问预算），
 * 对"修复/追问/约束/撤销"给出**可复现的结构指标**，不冒充真人自然度。
 *
 * 指标：repair_success / repair_false_positive / unnecessary_question_rate /
 * essential_clarification_recall / repeat_question_rate / constraint_enforcement / undo_success_rate。
 *
 * 用法：npx tsx scripts/conversation-eval/structural.ts
 */
import { writeFileSync } from 'node:fs';
import { understandDialogue } from '../../src/lib/cognitive/conversation/understanding/dialogue-act';
import { buildConversationState } from '../../src/lib/cognitive/conversation/state/conversation-state';
import { selectResponseAct } from '../../src/lib/cognitive/conversation/planning/response-act';
import { classifyRepair } from '../../src/lib/cognitive/conversation/state/dialogue-ledgers';
import { detectStyleUndo } from '../../src/lib/cognitive/conversation/learning/preference-extractor';
import { decideStyleAutonomy } from '../../src/lib/cognitive/conversation/learning/autonomy';

type Turn = { role: 'user' | 'assistant'; content: string };

interface Case {
  id: string;
  category: string;
  turns: Turn[];
  /** 每个用户轮次的断言（轮次用户消息序号，从 0 起）。 */
  checks: Array<{ at: number; fn: (r: TurnResult) => boolean }>;
  kind: 'repair_positive' | 'repair_negative' | 'sharing' | 'essential' | 'known_info' | 'constraint' | 'undo';
}

interface TurnResult {
  content: string;
  act: string;
  questionMove: string;
  questionReason: string;
  constraints: string[];
  contextNote: string;
  repairTypes: string[];
  undo: string | null;
}

/** 纯规则分析一轮（不含风格读取/提示词渲染，等价引擎的决策层）。 */
function analyze(content: string, history: Turn[], naturalness: 'low' | 'medium' | 'high' = 'high'): TurnResult {
  const u = understandDialogue(content);
  const state = buildConversationState(history, content, u);
  const act = selectResponseAct(u, state, content, naturalness);
  return {
    content,
    act: act.primary,
    questionMove: act.question?.responseMove ?? 'n/a',
    questionReason: act.question?.reasonCode ?? 'n/a',
    constraints: state.activeConstraints.map((c) => c.content),
    contextNote: act.contextNote ?? '',
    repairTypes: state.repairLedger.map((e) => e.type),
    undo: detectStyleUndo(content)
  };
}

const CASES: Case[] = [
  {
    id: 'r1', category: '真实纠正', kind: 'repair_positive',
    turns: [
      { role: 'user', content: '今天那个 Bug 搞得心烦。' },
      { role: 'assistant', content: '我给你几个排障步骤。' },
      { role: 'user', content: '我不是来排查，我就想聊两句。' }
    ],
    checks: [{ at: 1, fn: (r) => r.act === 'CORRECT_COURSE' && /不再推送排障/.test(r.contextNote) }]
  },
  {
    id: 'r2', category: '正常追加', kind: 'repair_negative',
    turns: [
      { role: 'user', content: '聊聊最近的睡眠。' },
      { role: 'assistant', content: '想从哪方面说？' },
      { role: 'user', content: '再深入点。' }
    ],
    checks: [{ at: 1, fn: (r) => r.act !== 'CORRECT_COURSE' && !classifyRepair('再深入点').isRepair }]
  },
  {
    id: 'q1', category: '分享', kind: 'sharing',
    turns: [{ role: 'user', content: '今天总算把拖了很久的报告写完了。' }],
    checks: [{ at: 0, fn: (r) => r.questionReason === 'SHARING' && r.questionMove === 'CONTINUE_WITHOUT_QUESTION' }]
  },
  {
    id: 'q2', category: '缺关键事实', kind: 'essential',
    turns: [{ role: 'user', content: '帮我订一张去北京的票。' }],
    checks: [{ at: 0, fn: (r) => r.questionMove === 'ASK_ONE' && r.questionReason === 'ESSENTIAL' }]
  },
  {
    id: 'q3', category: '关键信息已给', kind: 'known_info',
    turns: [{ role: 'user', content: '帮我订一张明天去北京的票。' }],
    checks: [{ at: 0, fn: (r) => r.questionMove !== 'ASK_ONE' }]
  },
  {
    id: 'q4', category: '已问未答', kind: 'known_info',
    turns: [
      { role: 'user', content: '就是那个问题。' },
      { role: 'assistant', content: '你是指缓存问题吗？' },
      { role: 'user', content: '嗯，差不多。' }
    ],
    checks: [{ at: 1, fn: (r) => r.questionMove !== 'ASK_ONE' && r.questionReason === 'ALREADY_KNOWN' }]
  },
  {
    id: 'c1', category: '临时约束', kind: 'constraint',
    turns: [
      { role: 'user', content: '这次不要列点，说说天空为什么是蓝色的。' },
      { role: 'assistant', content: '简短几句。' },
      { role: 'user', content: '那为什么冰会浮在水上？' }
    ],
    checks: [
      { at: 0, fn: (r) => r.constraints.includes('不使用列表/分点') && r.contextNote.includes('不使用列表/分点') },
      { at: 1, fn: (r) => !r.constraints.includes('不使用列表/分点') } // 跨主题后过期
    ]
  },
  {
    id: 'c2', category: '长期约束', kind: 'constraint',
    turns: [
      { role: 'user', content: '以后技术问题先讲原理。' },
      { role: 'assistant', content: '好。' },
      { role: 'user', content: '为什么网络会抖动？' }
    ],
    checks: [{ at: 1, fn: (r) => r.constraints.includes('优先讨论原理') && r.contextNote.includes('优先讨论原理') }]
  },
  {
    id: 'u1', category: '自然语言撤销', kind: 'undo',
    turns: [
      { role: 'user', content: '以后回答简短些。' },
      { role: 'assistant', content: '好。' },
      { role: 'user', content: '还是恢复原来的风格吧。' }
    ],
    checks: [{ at: 1, fn: (r) => r.undo === 'full' && r.constraints.length === 0 && decideStyleAutonomy({ scope: 'GLOBAL', autoLearnEnabled: false, isUndo: true }).permission === 'ALLOWED' }]
  }
];

/** 逐轮分析：每个用户轮用其之前的历史重建状态。 */
function runCase(c: Case): { results: TurnResult[]; pass: boolean[] } {
  const history: Turn[] = [];
  const results: TurnResult[] = [];
  for (const t of c.turns) {
    if (t.role === 'assistant') { history.push(t); continue; }
    results.push(analyze(t.content, [...history]));
    history.push(t);
  }
  const pass = c.checks.map((ch) => ch.fn(results[ch.at] ?? results[0]));
  return { results, pass };
}

function main() {
  let repairPos = 0, repairPosPass = 0;
  let repairNegFail = 0;
  let sharingTotal = 0, sharingAsk = 0;
  let essentialTotal = 0, essentialRecall = 0;
  let knownTotal = 0, knownAsk = 0;
  let constraintTotal = 0, constraintPass = 0;
  let undoTotal = 0, undoPass = 0;
  const rows: string[] = [];

  for (const c of CASES) {
    const { pass } = runCase(c);
    const ok = pass.every(Boolean);
    rows.push(`| ${c.id} | ${c.category} | ${ok ? '通过' : '**未通过**'} | ${pass.map((p) => (p ? '✓' : '✗')).join(' ')} |`);
    if (c.kind === 'repair_positive') { repairPos++; if (ok) repairPosPass++; }
    if (c.kind === 'repair_negative') { if (!ok) repairNegFail++; }
    if (c.kind === 'sharing') { sharingTotal++; if (pass.some((p) => !p)) sharingAsk++; }
    if (c.kind === 'essential') { essentialTotal++; if (ok) essentialRecall++; }
    if (c.kind === 'known_info') { knownTotal++; if (pass.some((p) => !p)) knownAsk++; }
    if (c.kind === 'constraint') { constraintTotal++; if (ok) constraintPass++; }
    if (c.kind === 'undo') { undoTotal++; if (ok) undoPass++; }
  }

  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);
  const report = [
    '# 对话智能层 v1.3 结构化评测（零模型/零数据库）',
    '',
    '- 说明：本表是**纯规则决策层**的可复现结构指标，不是真人自然度；自然度仍待人评。',
    '- 覆盖：真实纠正/正常追加、分享不追问、缺关键事实只问一个、已知信息不重复索取、临时/长期约束落实、自然语言撤销。',
    '',
    '## 指标',
    '| 指标 | 结果 | 定义 |',
    '|---|---|---|',
    `| repair_success | ${pct(repairPosPass, repairPos)} | 真纠正后回应动作确实改为修复且承接正确期待 |`,
    `| repair_false_positive | ${repairNegFail} | 正常追问被误判为纠正的次数（越低越好，理想 0） |`,
    `| unnecessary_question_rate | ${pct(sharingAsk, sharingTotal)} | 分享轮强制追问的比例（越低越好） |`,
    `| essential_clarification_recall | ${pct(essentialRecall, essentialTotal)} | 确需澄清时确实只问一个 |`,
    `| repeat_question_rate | ${pct(knownAsk, knownTotal)} | 已知信息仍再次索取的比例（越低越好） |`,
    `| constraint_enforcement | ${pct(constraintPass, constraintTotal)} | 临时约束仅本轮、长期约束持续遵守 |`,
    `| undo_success_rate | ${pct(undoPass, undoTotal)} | 自然语言撤销解析正确且确为可执行逆操作 |`,
    '',
    '## 分用例',
    '| 用例 | 分类 | 结果 | 断言 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '已知限制：规则覆盖有限（槽位任务、纠正句式），不代表任意表达都能正确识别；真实提升仍需人评与真模型 A/B。',
    '复现：`npx tsx scripts/conversation-eval/structural.ts`（不调用模型、不读数据库）'
  ].join('\n');

  writeFileSync(new URL('../../docs/CONVERSATION_V13_METRICS.md', import.meta.url), report);
  console.log(report);
  console.log('\n写入 docs/CONVERSATION_V13_METRICS.md');
}

main();