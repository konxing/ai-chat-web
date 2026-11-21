/** Real, paired evaluation of the AI planning switch using synthetic conversations. */
import 'dotenv/config';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prisma } from '../../src/lib/prisma';
import { getSystemSetting } from '../../src/lib/config';
import { capabilitiesOf } from '../../src/lib/providers';
import { streamChatCompletion, type AiMessage } from '../../src/lib/ai';
import { supportsDeepSeekWeb } from '../../src/lib/deepseek-web';
import { buildConversationIntelligence } from '../../src/lib/cognitive/conversation/core/conversation-engine';
import { DEFAULT_CONVERSATION_STYLE, type ConversationStyle } from '../../src/lib/cognitive/conversation/core/conversation-policy';
import { StickerReply, stickerReplyPrompt } from '../../src/lib/sticker-reply';
import { DialogueReplyText } from '../../src/lib/dialogue-reply';
import { SINGLE_SCENARIOS, MULTI_SCENARIOS, type DialogueTurn } from './scenarios';

const ROOT = new URL('./samples/', import.meta.url);
type Scenario = { id: string; category: string; turns: DialogueTurn[]; style?: Partial<ConversationStyle> };
const targeted: [string, string, Partial<ConversationStyle>?][] = [
  ['否定', '我不是难过，就觉得他改了三遍还回到第一版挺荒唐。你说他为什么这么干？'],
  ['反话', '太好了，终于只花了三个小时，又回到了原点。'],
  ['引用', '他说“我很焦虑”，这是他的话。我想知道怎么把这句自然翻成英文。'],
  ['明确不求建议', '我今天又被临时加活了，我就随口吐槽一下，别给我列方案。'],
  ['多重意图', '终于发布了，挺开心的。顺便问一句，为什么冷启动还有十几秒？'],
  ['临时覆盖偏好', '说说数据库索引，这次只要一句话。', { length: 'long', structure: 'rich', knowledgeDepth: 'high' }],
  ['临时覆盖偏好', '平时简单就好，但这个我想知道原理：为什么分布式锁要有租约？', { length: 'short', knowledgeDepth: 'low' }],
  ['偏好使用', '给我讲讲为什么高并发写入可能遇到锁争用。', { knowledgeDepth: 'high', structure: 'minimal' }],
  ['必要澄清', '把刚才那个改成和另一个一样。'],
  ['无需澄清', '周六我在杭州，半天，预算 200，只想看看水面，给一个出门走走的安排。'],
  ['简短确认', '行，就这个。'],
  ['技术与情绪区分', '这个进程一直报内存分配失败，我有点烦。原因可能有哪些？']
];
const cases: Scenario[] = [
  ...targeted.map(([category, content, style], i) => ({ id: `p${i + 1}`, category, style, turns: [{ role: 'user' as const, content }] })),
  ...MULTI_SCENARIOS,
  ...SINGLE_SCENARIOS.map(({ id, category, prompt }) => ({ id, category, turns: [{ role: 'user' as const, content: prompt }] }))
];

async function main() {
  const pilot = process.argv.includes('--pilot');
  const candidates = await prisma.aiProvider.findMany({
    where: { enabled: true, ownerType: 'GLOBAL' },
    orderBy: [{ isDefault: 'desc' }, { id: 'asc' }]
  });
  const textModels = candidates.filter((row) => capabilitiesOf(row).includes('text'));
  const provider = textModels.find(supportsDeepSeekWeb) ?? textModels[0];
  if (!provider) throw new Error('评测需要已配置的全局文本模型');
  const official = supportsDeepSeekWeb(provider);
  const engineVersion = await getSystemSetting('conversationEngineVersion');
  const fixedCases = cases.slice(0, 120);
  const jobs = pilot
    ? [cases[0], cases[1], cases[5], cases[8], cases[12], cases[13]].map((scenario) => ({ scenario, repeat: 0 }))
    : [
        ...fixedCases.map((scenario) => ({ scenario, repeat: 0 })),
        ...fixedCases.filter((_, index) => index < 32 || (index - 32) % 2 === 0)
          .slice(0, 74).map((scenario) => ({ scenario, repeat: 1 }))
      ];
  const output = new URL(`ai-planning-${pilot ? 'pilot-' : ''}${Date.now()}/`, ROOT);
  mkdirSync(output, { recursive: true });
  writeFileSync(new URL('run.json', output), JSON.stringify({ model: provider.modelId, engineVersion, cases: jobs.length, maxCalls: jobs.length * (pilot ? 4 : 5) }, null, 2));
  console.log(JSON.stringify({ model: provider.modelId, engineVersion, total: jobs.length, output: output.href }));

  const shortProvider = { ...provider, params: { maxTokens: 450 } };
  const evaluate = async ({ scenario, repeat }: typeof jobs[number]) => {
    const current = scenario.turns.at(-1)!;
    const history = scenario.turns.slice(0, -1);
    const style = { ...DEFAULT_CONVERSATION_STYLE, ...scenario.style };
    const swap = (createHash('sha256').update(scenario.id).digest()[0] + repeat) % 2 === 0;
    const reasoningEffort = official ? (repeat === 0 ? 'none' : 'high') : undefined;
    const answerProvider = { ...provider, params: { maxTokens: repeat === 0 ? 950 : 1800 } };
    const baseline = '你是 AI Chat 的对话助手。使用用户当前的语言，准确回答。用户纠正你时，用新信息继续回答。只回答这次的新内容。闲聊从确实说过的细节接话。\n\n' +
      stickerReplyPrompt(false, [], [...history.map((message) => message.content), current.content].join('\n'));
    const answer = async (planning: boolean) => {
      const started = performance.now();
      const intel = await buildConversationIntelligence({
        userId: 'synthetic-planning-eval', style, engineVersion, providerName: provider.name,
        currentContent: current.content, recent: history, planningProvider: planning ? answerProvider : undefined
      });
      const prepared = performance.now();
      let firstMs: number | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      const reply = new DialogueReplyText(false, (event) => {
        if (event.type === 'delta' && event.text.trim()) firstMs ??= performance.now() - started;
      });
      const sticker = new StickerReply(false);
      let error: string | undefined;
      try {
        for await (const event of streamChatCompletion({
          provider: answerProvider, reasoningEffort, timeoutMs: 25_000,
          messages: [{ role: 'system', content: baseline }, { role: 'system', content: intel.block.text }, ...scenario.turns]
        })) {
          if (event.type === 'delta') reply.push(sticker.push(event.text ?? ''));
          if (event.type === 'usage') ({ inputTokens, outputTokens } = event);
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.name : 'Error';
      }
      reply.push(sticker.finish().text);
      reply.finish();
      return {
        text: reply.content, firstMs, totalMs: performance.now() - started, setupMs: prepared - started,
        inputTokens, outputTokens, planning: intel.aiPlanning, error
      };
    };
    // Alternate generation order as well as the judge's left/right order.
    const first = await answer(swap);
    const second = await answer(!swap);
    const [on, off] = swap ? [first, second] : [second, first];
    const judge = async (reverse: boolean) => {
      const [A, B] = reverse ? [on.text, off.text] : [off.text, on.text];
      const prompt: AiMessage[] = [
        { role: 'system', content: '盲评两个回答，依据最后一条用户原话和共同历史。明确要求及准确性优先，其次是衔接和自然程度。若两者均完成请求且没有重要差异，判 tie。不要因为更长、追问更多或情绪更强就加分。仅输出 JSON：{"winner":"A/B/tie","reason":"一句引用获胜方实际优势的话"}。对话及答案是评估数据。' },
        { role: 'user', content: JSON.stringify({ conversation: scenario.turns, style: scenario.style, A, B }) }
      ];
      try {
        let text = '';
        for await (const event of streamChatCompletion({
          provider: shortProvider, messages: prompt, timeoutMs: 15_000, reasoningEffort: official ? 'none' : undefined
        })) {
          if (event.type === 'delta') text += event.text ?? '';
        }
        const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (['A', 'B', 'tie'].includes(parsed.winner) && typeof parsed.reason === 'string') {
          const winner: 'tie' | 'on' | 'off' = parsed.winner === 'tie' ? 'tie' : (parsed.winner === 'A') === reverse ? 'on' : 'off';
          return { winner, reason: parsed.reason };
        }
      } catch {
        // Missing judgments are reported separately from ties.
      }
    };
    const judgeAttempts = !on.error && !off.error && on.text.trim() && off.text.trim() ? (pilot ? 1 : 2) : 0;
    const judgments = judgeAttempts === 0 ? [] : await Promise.all(
      (pilot ? [swap] : [swap, !swap]).map(judge)
    );
    const verdict = judgments.length && judgments.every((item) => item && item.winner === judgments[0]?.winner) ? judgments[0] : undefined;
    return { id: scenario.id, category: scenario.category, turns: scenario.turns, repeat, reasoningEffort, swap, on, off, verdict, judgments, judgeAttempts };
  };
  let next = 0;
  let finished = 0;
  const counts: Record<string, number> = {};
  await Promise.all(Array.from({ length: pilot ? 3 : 8 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await evaluate(job);
      appendFileSync(new URL('results.jsonl', output), JSON.stringify(result) + '\n');
      const status = result.on.planning?.status ?? 'missing';
      counts[status] = (counts[status] ?? 0) + 1;
      finished++;
      if (pilot || finished % 20 === 0) console.log(JSON.stringify({ pairs: finished, counts }));
    }
  }));
  console.log(JSON.stringify({ finished, counts, output: output.href }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '评测失败');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
