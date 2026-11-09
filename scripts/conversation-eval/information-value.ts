/* eslint-disable no-console */
/**
 * Offline comparison of three response strategies and the current engine.
 * Run: npx tsx scripts/conversation-eval/information-value.ts [case-id ...]
 * Uses fictional conversations only. Raw responses stay in ignored samples/.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../../src/lib/prisma';
import { streamChatCompletion } from '../../src/lib/ai';
import { resolveDefaultProvider } from '../../src/lib/providers';
import { buildConversationIntelligence } from '../../src/lib/cognitive/conversation/core/conversation-engine';
import { renderGlobalPolicy } from '../../src/lib/cognitive/conversation/core/conversation-policy';
import type { DialogueTurn } from './scenarios';

const owner = process.env.CONVERSATION_EVAL_USER_ID ?? '8eb553a1-ac9d-476b-bce3-783aa4f67fbc';
const baseSystem = '你是一位可靠、温和的家庭 AI 助手。请使用用户当前使用的语言回答，保持准确，不声称执行了未执行的操作。';
const strategies = {
  direct: '直接接话或完成能完成的部分。不要向用户提问，也不要编造缺失信息。',
  assumption: '如果需要假设，明确说出一个可纠正的假设，然后给出在该假设下有用的回答。不要向用户提问。',
  clarify: '先问一个最能改变回答的问题。如果找不到有实际帮助的问题，就直接接话。'
} as const;
type Strategy = keyof typeof strategies;
type Case = { id: string; history: DialogueTurn[]; content: string; criteria: string };
const cases: Case[] = [
  {
    id: 'report-chat',
    history: [{ role: 'user', content: '今天只想随便聊聊，不用给建议。' }, { role: 'assistant', content: '好。' }],
    content: '总算把报告写完了。',
    criteria: '接住进展即可。不猜用户写的是什么报告，不问进度，不安排下一步。'
  },
  {
    id: 'report-review',
    history: [{ role: 'user', content: '报告写完后想请你帮我润色，重点看表达，先别改数据。' }, { role: 'assistant', content: '行，写完把正文发我。' }],
    content: '总算把报告写完了。',
    criteria: '接住先前的润色安排，简短提醒可以贴正文。别假装已读，也别再问改什么。'
  },
  {
    id: 'learn-example',
    history: [{ role: 'user', content: '我第一次学导数，刚看懂了速度的例子。' }, { role: 'assistant', content: '导数也能描述温度随时间的变化。' }],
    content: '再举一个例子。',
    criteria: '直接给一个初学者能懂的不同例子。无需再问想学什么或已经学到哪里。'
  },
  {
    id: 'book-unknown-date',
    history: [{ role: 'user', content: '从上海出发，目的地北京。' }, { role: 'assistant', content: '好。' }],
    content: '帮我订一张高铁票。',
    criteria: '日期会改变可选车次。只问出发日期，不猜日期，不重复问出发地或目的地，不声称已订。'
  },
  {
    id: 'book-known-date',
    history: [{ role: 'user', content: '我明天从上海出发去北京，上午出发就行。' }, { role: 'assistant', content: '知道了。' }],
    content: '帮我订一张高铁票。',
    criteria: '沿用明天、上海到北京和上午出发。说明能提供的帮助，不重复索取日期，不声称已订。'
  },
  {
    id: 'correction',
    history: [{ role: 'user', content: '我最近做事容易卡在第一步。' }, { role: 'assistant', content: '可以试试把任务拆成三步，再制定计划。' }],
    content: '我不是想找办法。我只是觉得，越想一次做好，越不敢动手。',
    criteria: '尊重用户纠正，顺着一次做好和不敢开始的关系接话。不再给方案或连环追问。'
  }
];

async function main() {
  const ids = new Set(process.argv.slice(2));
  const selected = ids.size ? cases.filter((item) => ids.has(item.id)) : cases;
  if (ids.size && selected.length !== ids.size) throw new Error('Unknown case ID');
  const provider = await resolveDefaultProvider(owner);
  const out = new URL(`./samples/information-value-${Date.now()}/`, import.meta.url);
  mkdirSync(out, { recursive: true });
  console.log(`Model: ${provider.modelId}`);
  for (const item of selected) {
    const intel = await buildConversationIntelligence({
      userId: owner, currentContent: item.content, recent: item.history, engineVersion: 'dialogue-v2'
    });
    const arms = Object.entries(strategies).map(([id, instruction]) => ({
      id: id as Strategy | 'current',
      prompt: renderGlobalPolicy(intel.style) + '\n\n【本轮策略】' + instruction
    }));
    arms.push({ id: 'current', prompt: intel.block.text });
    const answers = await Promise.all(arms.map(async (arm) => {
      let text = '';
      try {
        for await (const event of streamChatCompletion({
          provider, timeoutMs: 45_000, signal: AbortSignal.timeout(45_000),
          messages: [
            { role: 'system', content: baseSystem + '\n\n' + arm.prompt },
            ...item.history,
            { role: 'user', content: item.content }
          ]
        })) {
          if (event.type === 'delta') text += event.text ?? '';
        }
        return text.trim() ? { arm: arm.id, text } : { arm: arm.id, error: 'empty response' };
      } catch (error) {
        // A timed out response must not count as a failed strategy.
        return { arm: arm.id, error: error instanceof Error ? error.name : 'request failed' };
      }
    }));
    writeFileSync(new URL(`${item.id}.json`, out), JSON.stringify({
      ...item, model: provider.modelId, currentMove: intel.act.question?.responseMove, answers
    }, null, 2));
    console.log(`${item.id}: ${answers.filter((answer) => answer.text).length}/${arms.length} responses`);
  }
  console.log(out.href);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
