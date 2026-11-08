/* eslint-disable no-console */
/**
 * 对话智能层 v2 对照评测（P0 重建，修复 F-01/F-02/F-04/F-10）。
 *
 * - 每个单轮场景在生成前用当轮消息动态 buildConversationIntelligence（不再循环外静态复用）。
 * - 多轮用真实 user/assistant 交替序列回放，两臂共享同一历史/模型/配置，唯一差异=是否启用对话层。
 * - 成对回答随机交换 A/B（记录种子），匿名样本落本地 samples/（不写公共日志、不含真实用户数据）。
 * - 指标分离：templateFlagRate（程序，仅模板症状，不称真人感）/ intentFit / continuity / independence /
 *   factuality（judge 辅助）/ humanNaturalness（留空待人评）/ latencyP50/P95 / tokens。
 * - 分场景统计；报告注明样本量/不确定性/评委偏差/模型参数/代码版本/开关/Prompt 版本；旧 5:3 标注不足。
 *
 * 用法：npx tsx scripts/conversation-eval/run.ts --limit 6 --multi 4 [--judge] [--seed 42]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { streamChatCompletion } from '../../src/lib/ai';
import { resolveDefaultProvider } from '../../src/lib/providers';
import { buildConversationIntelligence } from '../../src/lib/cognitive/conversation/core/conversation-engine';
import { checkResponseQuality } from '../../src/lib/cognitive/conversation/quality/response-quality';
import { SINGLE_SCENARIOS, MULTI_SCENARIOS, type DialogueTurn } from './scenarios';

const prisma = new PrismaClient();
const OWNER = '8eb553a1-ac9d-476b-bce3-783aa4f67fbc';

const BASE_SYSTEM =
  '你是一位可靠、温和的家庭 AI 助手。请使用用户当前使用的语言回答。' +
  '回答应准确、结构清晰；代码使用 Markdown 代码块；数学公式使用 LaTeX。' +
  '如果提供了文档摘录，请优先依据文档内容回答，并明确说明不确定之处。' +
  '不要声称自己看到了未提供的图片或文件。';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) || fallback : fallback;
}
function strArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}
function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }

// 可复现随机（mulberry32）。
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenResult { text: string; input: number; output: number; ms: number }
async function generate(provider: Awaited<ReturnType<typeof resolveDefaultProvider>>, messages: { role: 'system'|'user'|'assistant'; content: string }[]): Promise<GenResult> {
  const t0 = Date.now();
  let text = ''; let input = 0; let output = 0;
  for await (const ev of streamChatCompletion({ provider, messages, timeoutMs: 60_000 })) {
    if (ev.type === 'delta' && ev.text) text += ev.text;
    if (ev.type === 'usage') { input = ev.inputTokens ?? input; output = ev.outputTokens ?? output; }
  }
  return { text, input, output, ms: Date.now() - t0 };
}

async function layerSystemFor(content: string, history: DialogueTurn[], engineVersion: 'legacy' | 'dialogue-v2'): Promise<string> {
  const intel = await buildConversationIntelligence({ userId: OWNER, currentContent: content, recentDeep: history.length > 2, recent: history, engineVersion });
  return BASE_SYSTEM + '\n\n' + intel.block.text;
}

interface CaseResult {
  id: string; category: string; kind: 'single' | 'multi';
  base: GenResult; layer: GenResult;
  baseTemplate: number; layerTemplate: number;
  winner?: 'layer' | 'base' | 'tie';
  judge?: Record<string, number>;
}

async function main() {
  const limit = arg('limit', 6);
  const multiLimit = arg('multi', 4);
  const seed = arg('seed', 42);
  const doJudge = hasFlag('judge');
  const engine = strArg('engine', 'legacy') === 'dialogue-v2' ? 'dialogue-v2' : 'legacy';
  const rand = rng(seed);
  const provider = await resolveDefaultProvider(OWNER);
  const judgeProvider = doJudge ? provider : null; // 同族评委仅作辅助，报告注明偏差；可换独立模型
  const runId = `${engine}-${Date.now().toString(36)}`;
  const sampleDir = new URL(`./samples/${runId}/`, import.meta.url);
  mkdirSync(sampleDir, { recursive: true });

  const results: CaseResult[] = [];
  const latencies: number[] = [];
  let totalIn = 0, totalOut = 0;

  const singles = SINGLE_SCENARIOS.slice(0, limit).map((s) => ({ id: s.id, category: s.category, kind: 'single' as const, turns: [{ role: 'user', content: s.prompt }] as DialogueTurn[] }));
  const multis = MULTI_SCENARIOS.slice(0, multiLimit).map((m) => ({ id: m.id, category: m.category, kind: 'multi' as const, turns: m.turns }));

  for (const c of [...singles, ...multis]) {
    // 两臂各自回放，共享同一用户/助手历史结构；唯一差异=system 是否含对话层。
    const baseHist: DialogueTurn[] = [];
    const layerHist: DialogueTurn[] = [];
    let baseLast: GenResult = { text: '', input: 0, output: 0, ms: 0 };
    let layerLast: GenResult = { text: '', input: 0, output: 0, ms: 0 };
    for (const turn of c.turns) {
      if (turn.role === 'assistant') { baseHist.push(turn); layerHist.push(turn); continue; }
      const baseMsgs = [{ role: 'system' as const, content: BASE_SYSTEM }, ...baseHist, { role: 'user' as const, content: turn.content }];
      const layerSys = await layerSystemFor(turn.content, layerHist, engine);
      const layerMsgs = [{ role: 'system' as const, content: layerSys }, ...layerHist, { role: 'user' as const, content: turn.content }];
      baseLast = await generate(provider, baseMsgs);
      layerLast = await generate(provider, layerMsgs);
      baseHist.push({ role: 'user', content: turn.content }, { role: 'assistant', content: baseLast.text });
      layerHist.push({ role: 'user', content: turn.content }, { role: 'assistant', content: layerLast.text });
    }
    latencies.push(baseLast.ms, layerLast.ms);
    totalIn += baseLast.input + layerLast.input; totalOut += baseLast.output + layerLast.output;

    const bq = checkResponseQuality({ text: baseLast.text });
    const lq = checkResponseQuality({ text: layerLast.text });
    const r: CaseResult = {
      id: c.id, category: c.category, kind: c.kind,
      base: baseLast, layer: layerLast,
      baseTemplate: bq.flags.length ? 1 : 0, layerTemplate: lq.flags.length ? 1 : 0
    };

    if (judgeProvider) {
      const swap = rand() < 0.5;
      const [a, b] = swap ? [layerLast.text, baseLast.text] : [baseLast.text, layerLast.text];
      const lastUser = [...c.turns].reverse().find((t) => t.role === 'user')?.content ?? '';
      const jp = `独立评审。用户最后说：${lastUser}\n回答A：\n${a}\n回答B：\n${b}\n` +
        '按 intentFit/continuity/independence/factuality/naturalness 各打0-1，并给winner(A/B/tie)。只输出JSON。';
      let raw = '';
      for await (const ev of streamChatCompletion({ provider: judgeProvider, messages: [{ role: 'user', content: jp }], timeoutMs: 60_000 })) {
        if (ev.type === 'delta' && ev.text) raw += ev.text;
      }
      try {
        const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        const w = j.winner === 'A' ? (swap ? 'layer' : 'base') : j.winner === 'B' ? (swap ? 'base' : 'layer') : 'tie';
        r.winner = w;
        r.judge = { intentFit: j.intentFit ?? 0, continuity: j.continuity ?? 0, independence: j.independence ?? 0, factuality: j.factuality ?? 0, naturalness: j.naturalness ?? 0 };
      } catch { r.winner = 'tie'; }
    }

    writeFileSync(new URL(`${c.id}.json`, sampleDir), JSON.stringify({ id: c.id, category: c.category, kind: c.kind, seed, base: baseLast.text, layer: layerLast.text, winner: r.winner }, null, 2));
    results.push(r);
    console.log(`${c.id}(${c.category},${c.kind}) base=${baseLast.ms}ms layer=${layerLast.ms}ms winner=${r.winner ?? 'n/a'}`);
  }

  const judged = results.filter((r) => r.winner);
  const layerWins = judged.filter((r) => r.winner === 'layer').length;
  const baseWins = judged.filter((r) => r.winner === 'base').length;
  const ties = judged.filter((r) => r.winner === 'tie').length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
  const byCat = new Map<string, CaseResult[]>();
  for (const r of results) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);

  const report = [
    `# 对话智能层对照评测报告（引擎=${engine}）`,
    '',
    `- 代码版本：见 git HEAD；开关：对话层仅实验臂启用（生产默认 OFF）；引擎臂=${engine}；Prompt 版本：默认。`,
    `- 模型：${provider.name}（${provider.modelId}）；评委：${doJudge ? '同族模型（辅助，有偏差，需人评复核）' : '未启用（仅程序指标）'}；种子=${seed}。`,
    `- 样本：单轮 ${singles.length} + 真实多轮 ${multis.length} = ${results.length}。旧版 8 子样本 5:3 结果**不足以判定提升/退化**（F-10）。`,
    `- 盲测：层 ${layerWins} / 基线 ${baseWins} / 平 ${ties}（n=${judged.length}，小样本，置信区间宽，不作上线依据）。`,
    `- templateFlagRate：基线 ${(results.reduce((s, r) => s + r.baseTemplate, 0) / results.length).toFixed(2)} / 层 ${(results.reduce((s, r) => s + r.layerTemplate, 0) / results.length).toFixed(2)}（仅模板症状，非真人感）。`,
    `- humanNaturalness：留空，待双人盲评 ≥30 组。`,
    `- 时延 P50=${p(0.5)}ms P95=${p(0.95)}ms；Token 入=${totalIn} 出=${totalOut}。`,
    '',
    '## 分场景',
    '| 场景 | n | 层胜 | 基线胜 | 平 |',
    '|---|---|---|---|---|',
    ...[...byCat.entries()].map(([cat, rs]) => `| ${cat} | ${rs.length} | ${rs.filter((r) => r.winner === 'layer').length} | ${rs.filter((r) => r.winner === 'base').length} | ${rs.filter((r) => r.winner === 'tie').length} |`),
    '',
    '匿名成对样本存 scripts/conversation-eval/samples/（本地，不含真实用户数据）。人评与独立评委为上线前必需。'
  ].join('\n');
  writeFileSync(new URL(`../../docs/CONVERSATION_EVAL_REPORT_${engine}.md`, import.meta.url), report);
  writeFileSync(new URL('../../docs/CONVERSATION_EVAL_REPORT.md', import.meta.url), report);
  console.log(`\n报告写入 docs/CONVERSATION_EVAL_REPORT_${engine}.md`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
