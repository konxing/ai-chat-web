/* eslint-disable no-console */
/**
 * 模拟多轮评测（v1.3 附录 A.6，可选、辅助）。目标驱动：模拟用户按被测模型的实际回答继续，
 * 评价整段会话的最终意图完成度/意图漂移/连续性/多余追问。
 *
 * - 仅辅助证据：模拟用户与评委同族，不代表真人；transcript 只落本地 samples/（gitignored）。
 * - 目标数/轮数有上限，成本可控。
 * 用法：npx tsx scripts/conversation-eval/simulated.ts [--goals 3] [--turns 4]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { streamChatCompletion } from '../../src/lib/ai';
import { resolveDefaultProvider } from '../../src/lib/providers';
import { buildConversationIntelligence } from '../../src/lib/cognitive/conversation/core/conversation-engine';

const prisma = new PrismaClient();
const OWNER = '8eb553a1-ac9d-476b-bce3-783aa4f67fbc';
const BASE_SYSTEM =
  '你是 AI Chat 的对话助手。请使用用户当前使用的语言回答。' +
  '回答应准确、结构清晰；代码使用 Markdown 代码块；数学公式使用 LaTeX。' +
  '不要声称自己看到了未提供的图片或文件。';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) || fallback : fallback;
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
async function generate(provider: Awaited<ReturnType<typeof resolveDefaultProvider>>, messages: Msg[]): Promise<string> {
  let text = '';
  for await (const ev of streamChatCompletion({ provider, messages, timeoutMs: 60_000 })) {
    if (ev.type === 'delta' && ev.text) text += ev.text;
  }
  return text.indexOf('<!--') >= 0 ? text.split('<!--')[0] : text;
}

const GOALS = [
  { id: 'g1', goal: '用户只是想分享今天终于写完报告、有点累，希望被自然承接，不想被给方案或连环追问。', opening: '今天总算把拖了很久的报告写完了，人有点虚。' },
  { id: 'g2', goal: '用户想排查“服务偶尔超时”，需要具体、可执行的诊断思路，不要空泛安抚。', opening: '服务偶尔超时，CPU 不高，怎么定位？' },
  { id: 'g3', goal: '用户一开始被助手当成要排障而烦，明确纠正“我只想聊聊”；助手应修复并自然聊，不再推方案。', opening: '今天那个 Bug 搞得我心烦。' }
];

interface Turn { role: 'user' | 'assistant'; content: string }

async function runGoal(provider: Awaited<ReturnType<typeof resolveDefaultProvider>>, goal: typeof GOALS[number], maxTurns: number) {
  const transcript: Turn[] = [{ role: 'user', content: goal.opening }];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const lastUser = transcript[transcript.length - 1].content;
    const intel = await buildConversationIntelligence({
      userId: OWNER, currentContent: lastUser, recent: transcript.slice(0, -1), recentDeep: transcript.length > 3, engineVersion: 'dialogue-v2'
    });
    const sys = BASE_SYSTEM + '\n\n' + intel.block.text;
    const assistant = await generate(provider, [
      { role: 'system', content: sys },
      ...transcript.map((t) => ({ role: t.role, content: t.content })),
    ]);
    transcript.push({ role: 'assistant', content: assistant });
    if (turn === maxTurns) break;
    // 模拟用户：依据助手实际回答生成下一句。
    const sim = await generate(provider, [
      { role: 'user', content:
        `你在扮演一个真实用户。目标：${goal.goal}\n对话记录：\n${transcript.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n')}\n` +
        '请只输出你下一句自然的中文消息（最多 40 字），不要替助手回答，不要跳出目标，不要写解释。' }
    ]);
    transcript.push({ role: 'user', content: sim.trim().slice(0, 120) });
  }
  // 评估（同族辅助）。
  const raw = await generate(provider, [
    { role: 'user', content:
      `请评估这段对话是否达成用户目标。目标：${goal.goal}\n记录：\n${transcript.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n')}\n` +
      '输出 JSON：{"final_intent_completion":0-1,"intent_drift":0-1,"continuity":0-1,"unnecessary_question":0-1}，只输出 JSON。' }
  ]);
  let score = { final_intent_completion: 0, intent_drift: 1, continuity: 0, unnecessary_question: 1 };
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    score = {
      final_intent_completion: Number(j.final_intent_completion) || 0,
      intent_drift: Number(j.intent_drift ?? 1),
      continuity: Number(j.continuity) || 0,
      unnecessary_question: Number(j.unnecessary_question ?? 1)
    };
  } catch { /* keep defaults, marked as parse-fail */ }
  return { goal, transcript, score };
}

async function main() {
  const goalCount = Math.min(arg('goals', 3), GOALS.length);
  const maxTurns = Math.min(arg('turns', 4), 6);
  const provider = await resolveDefaultProvider(OWNER);
  const runId = Date.now().toString(36);
  const dir = new URL(`./samples/simulated-${runId}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });

  const results: Array<Awaited<ReturnType<typeof runGoal>>> = [];
  for (const g of GOALS.slice(0, goalCount)) {
    const r = await runGoal(provider, g, maxTurns);
    results.push(r);
    writeFileSync(new URL(`${g.id}.json`, dir), JSON.stringify(r, null, 2)); // 本地 gitignored
    console.log(`${g.id} completion=${r.score.final_intent_completion} drift=${r.score.intent_drift} continuity=${r.score.continuity} unnecessaryQ=${r.score.unnecessary_question}`);
  }
  const avg = (k: keyof typeof results[number]['score']) =>
    (results.reduce((s, r) => s + r.score[k], 0) / results.length).toFixed(2);
  const report = [
    '# 对话智能层 v1.3 模拟多轮评测（目标驱动，辅助）',
    '',
    `- 模型：${provider.name}（${provider.modelId}）；模拟用户与评委同族，**仅辅助，不代表真人**。`,
    `- 目标数=${results.length}，每目标最多 ${maxTurns} 轮；transcript 只存本地 samples/（gitignored），不写公共日志。`,
    `- 平均：final_intent_completion=${avg('final_intent_completion')}，intent_drift=${avg('intent_drift')}（越低越好），continuity=${avg('continuity')}，unnecessary_question=${avg('unnecessary_question')}（越低越好）。`,
    '',
    '| 目标 | completion | drift | continuity | unnecessaryQ |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.goal.id} | ${r.score.final_intent_completion} | ${r.score.intent_drift} | ${r.score.continuity} | ${r.score.unnecessary_question} |`),
    '',
    '限制：模拟用户由同族模型生成，可能过于配合或偏离；不得用本表证明真人自然度；上线仍需双人盲评 ≥30 组 + 异族评委。',
    '复现：`npx tsx scripts/conversation-eval/simulated.ts --goals 3 --turns 4`'
  ].join('\n');
  writeFileSync(new URL('../../docs/CONVERSATION_V13_SIMULATED.md', import.meta.url), report);
  console.log('\n写入 docs/CONVERSATION_V13_SIMULATED.md');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });