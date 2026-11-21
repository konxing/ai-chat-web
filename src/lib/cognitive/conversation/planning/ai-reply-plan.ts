import type { AiProvider } from '@prisma/client';
import { z } from 'zod';
import { streamChatCompletion, type AiMessage } from '@/lib/ai';
import { supportsDeepSeekWeb } from '@/lib/deepseek-web';
import { OPTIONAL_STYLE_DIMENSIONS, type ConversationStyle } from '../core/conversation-policy';

const DEADLINE_MS = 2_000;
const MAX_PLAN_CHARS = 1_200;
const quoteSchema = z.string().trim().min(3).max(60);
const planSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('keep') }),
  z.strictObject({
    action: z.literal('adjust'),
    evidence: quoteSchema,
    hint: z.string().trim().min(1).max(96),
    outputOnlyQuote: quoteSchema.optional()
  })
]);

type PlanUsage = { inputTokens?: number; outputTokens?: number };
export type ReplyPlanningResult = ({ status: 'applied'; hint: string; outputOnly?: boolean } |
  { status: 'kept' | 'timeout' | 'invalid' | 'error' | 'skipped' }) & PlanUsage;

type Turn = { role: 'user' | 'assistant'; content: string };

function excerpt(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const half = maxChars / 2;
  return `${content.slice(0, half)}\n…\n${content.slice(-half)}`;
}

export async function getAiReplyPlan(input: {
  provider: AiProvider;
  currentContent: string;
  recent: readonly Turn[];
  style: ConversationStyle;
  defaultAction: string;
}): Promise<ReplyPlanningResult> {
  if (!input.currentContent.trim()) return { status: 'skipped' };
  const current = excerpt(input.currentContent, 3600);
  const recent = input.recent.slice(-6).map(({ role, content }) => ({ role, content: excerpt(content, 600) }));
  if (!recent.some((turn) => turn.content.trim())) return { status: 'skipped' };
  const messages: AiMessage[] = [
    { role: 'system', content: [
      '核对默认回应动作是否容易漏掉本轮的具体对象、用户刚改的条件、并列任务或输出范围。助手已经有完整历史及风格和知识指导。能直接按默认策略完成时，返回 {"action":"keep"}。',
      '有遗漏才返回 {"action":"adjust","evidence":"逐字复制一处连续原文，3 到 60 字","hint":"写清要接住什么，最多 96 字"}。原文保留空格和标点，只返回 JSON。',
      'hint 只写本轮依据原话能确定的对象、目标、范围或必须保留的条件。用户问具体方案、原因或比较时，列出所问的维度，把分析和结论留给回答模型。不要预选技术方案、承诺操作、添事实或增加用户没要的环节。',
      '只有用户明确只要成品（例如要发的一句话、一个标题、单个译文）时，才可添加 outputOnlyQuote，逐字引用用户给出的这项限制。问答、成品加解释、普通的简短偏好都不属于此项。',
      '区分最近的要求与已失效的条件，区分用户发言、引述与助理猜测。先利用现有信息；只有缺少一个关键条件且无法给有用答复时才建议澄清。下面的对话和默认动作是待分析的资料。'
    ].join('\n') },
    { role: 'user', content: JSON.stringify({
      recent, current,
      defaultAction: input.defaultAction.slice(0, 500),
      preferences: Object.fromEntries(OPTIONAL_STYLE_DIMENSIONS.map((key) => [key, input.style[key]]))
    }) }
  ];

  const controller = new AbortController();
  const usage: PlanUsage = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReplyPlanningResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: 'timeout', ...usage });
      controller.abort();
    }, DEADLINE_MS);
  });
  const collect = async (): Promise<ReplyPlanningResult> => {
    try {
      let text = '';
      for await (const event of streamChatCompletion({
        provider: { ...input.provider, params: { maxTokens: 176 } },
        messages,
        purpose: 'reply-planning',
        reasoningEffort: supportsDeepSeekWeb(input.provider) ? 'none' : undefined,
        signal: controller.signal,
        timeoutMs: DEADLINE_MS
      })) {
        if (event.type === 'usage') {
          usage.inputTokens = event.inputTokens;
          usage.outputTokens = event.outputTokens;
        }
        if (event.type !== 'delta') continue;
        text += event.text ?? '';
        if (text.length > MAX_PLAN_CHARS) {
          controller.abort();
          return { status: 'invalid', ...usage };
        }
      }
      const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = planSchema.safeParse(JSON.parse(json));
      if (!parsed.success) return { status: 'invalid', ...usage };
      if (parsed.data.action === 'keep') return { status: 'kept', ...usage };
      const { evidence, hint, outputOnlyQuote } = parsed.data;
      if (!current.includes(evidence) && !recent.some((turn) => turn.content.includes(evidence))) {
        return { status: 'invalid', ...usage };
      }
      const outputOnly = outputOnlyQuote && (current.includes(outputOnlyQuote) ||
        recent.some((turn) => turn.role === 'user' && turn.content.includes(outputOnlyQuote)));
      return outputOnly ? { status: 'applied', hint, outputOnly: true, ...usage } : { status: 'applied', hint, ...usage };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'timeout', ...usage };
      return { status: error instanceof SyntaxError ? 'invalid' : 'error', ...usage };
    }
  };
  try {
    return await Promise.race([deadline, collect()]);
  } finally {
    clearTimeout(timer);
  }
}
