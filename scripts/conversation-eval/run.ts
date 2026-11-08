/* eslint-disable no-console */
/**
 * 对话智能层对照评测（Phase 8）。真实模型调用，匿名成对盲测 + LLM-as-judge + 程序自然度 + token 统计。
 *
 * 用法：npx tsx scripts/conversation-eval/run.ts --limit 8 --multi 4
 * 对每个场景生成两份回答：A=基线 system，B=基线+对话智能层；随机交换位置后交给独立 judge 模型盲评。
 * 候选 prompt 不得仅凭自评上线；本运行器用固定测试集，优化须另用验证集。
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { streamChatCompletion } from '../../src/lib/ai';
import { resolveDefaultProvider } from '../../src/lib/providers';
import { buildConversationIntelligence } from '../../src/lib/cognitive/conversation/core/conversation-engine';
import { checkResponseQuality } from '../../src/lib/cognitive/conversation/quality/response-quality';
import { SINGLE_SCENARIOS, MULTI_SCENARIOS } from './scenarios';

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

async function generate(provider: Awaited<ReturnType<typeof resolveDefaultProvider>>, system: string, user: string) {
  let text = '';
  let input = 0;
  let output = 0;
  for await (const ev of streamChatCompletion({
    provider,
    messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
    timeoutMs: 60_000
  })) {
    if (ev.type === 'delta' && ev.text) text += ev.text;
    if (ev.type === 'usage') { input = ev.inputTokens ?? input; output = ev.outputTokens ?? output; }
  }
  return { text, input, output };
}

async function judge(provider: Awaited<ReturnType<typeof resolveDefaultProvider>>, question: string, a: string, b: string): Promise<'A' | 'B' | 'tie'> {
  const prompt =
    `你是独立评审。用户问题：${question}\n\n回答A：\n${a}\n\n回答B：\n${b}\n\n` +
    '只根据：准确回应、自然、深度、有用知识联系、避免重复、不过度模板化、符合情境，判断哪个更好。' +
    '只输出 JSON：{"winner":"A"|"B"|"tie"}';
  let raw = '';
  for await (const ev of streamChatCompletion({ provider, messages: [{ role: 'user', content: prompt }], timeoutMs: 60_000 })) {
    if (ev.type === 'delta' && ev.text) raw += ev.text;
  }
  const m = raw.match(/"winner"\s*:\s*"(A|B|tie)"/);
  return (m?.[1] as 'A' | 'B' | 'tie') ?? 'tie';
}

async function main() {
  const limit = arg('limit', 8);
  const multiLimit = arg('multi', 4);
  const provider = await resolveDefaultProvider(OWNER);
  const intelligence = await buildConversationIntelligence({ userId: OWNER, currentContent: '' });
  const layerSystem = BASE_SYSTEM + '\n\n' + intelligence.block.text;

  const singles = SINGLE_SCENARIOS.slice(0, limit);
  const multis = MULTI_SCENARIOS.slice(0, multiLimit);

  let layerWins = 0, baseWins = 0, ties = 0;
  let baseNat = 0, layerNat = 0, natCount = 0;
  let totalIn = 0, totalOut = 0;
  const rows: string[] = [];

  const cases: { id: string; question: string; noList?: boolean }[] = [
    ...singles.map((s) => ({ id: s.id, question: s.prompt, noList: s.noList })),
    ...multis.map((m) => ({ id: m.id, question: m.turns.join('\n') }))
  ];

  for (const c of cases) {
    const base = await generate(provider, BASE_SYSTEM, c.question);
    const layer = await generate(provider, layerSystem, c.question);
    totalIn += base.input + layer.input;
    totalOut += base.output + layer.output;

    const bq = checkResponseQuality({ text: base.text, userAskedNoList: c.noList });
    const lq = checkResponseQuality({ text: layer.text, userAskedNoList: c.noList });
    baseNat += bq.naturalness; layerNat += lq.naturalness; natCount++;

    // 盲测：随机交换 A/B 位置，judge 不知道哪个是优化版。
    const swap = Math.random() < 0.5;
    const [a, b] = swap ? [layer.text, base.text] : [base.text, layer.text];
    const winner = await judge(provider, c.question, a, b);
    const layerIsA = swap;
    if (winner === 'tie') ties++;
    else if ((winner === 'A') === layerIsA) layerWins++;
    else baseWins++;

    rows.push(`| ${c.id} | ${winner === 'tie' ? '平' : (winner === 'A') === layerIsA ? '层' : '基线'} | ${bq.naturalness.toFixed(2)} | ${lq.naturalness.toFixed(2)} | ${lq.flags.join('/') || '-'} |`);
    console.log(`${c.id}: winner=${winner} baseNat=${bq.naturalness.toFixed(2)} layerNat=${lq.naturalness.toFixed(2)}`);
  }

  const report = [
    '# 对话智能层对照评测报告（真实模型）',
    '',
    `- 模型：${provider.name}（${provider.modelId}）`,
    `- 样本：单轮 ${singles.length} + 多轮 ${multis.length} = ${cases.length}（固定测试集子集；全量 100+20 见 scenarios.ts）`,
    `- 盲测胜场：对话层 ${layerWins} / 基线 ${baseWins} / 平 ${ties}`,
    `- 平均自然度：基线 ${(baseNat / natCount).toFixed(2)} / 对话层 ${(layerNat / natCount).toFixed(2)}`,
    `- Token：输入 ${totalIn} / 输出 ${totalOut}（含 judge）`,
    '',
    '| 场景 | 盲测胜方 | 基线自然度 | 层自然度 | 层 flag |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '说明：judge 为同族模型盲评，仅作佐证；重要样本需人工抽查。候选 prompt 上线须过独立验证集。'
  ].join('\n');
  writeFileSync(new URL('../../docs/CONVERSATION_EVAL_REPORT.md', import.meta.url), report);
  console.log('\n报告已写入 docs/CONVERSATION_EVAL_REPORT.md');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
