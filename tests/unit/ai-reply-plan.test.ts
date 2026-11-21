import { afterEach, expect, it, vi } from 'vitest';
import type { AiProvider } from '@prisma/client';
import { getAiReplyPlan } from '@/lib/cognitive/conversation/planning/ai-reply-plan';
import { streamChatCompletion } from '@/lib/ai';
import { DEFAULT_CONVERSATION_STYLE } from '@/lib/cognitive/conversation/core/conversation-policy';

vi.mock('@/lib/ai', () => ({ streamChatCompletion: vi.fn() }));
const stream = vi.mocked(streamChatCompletion);
const input = {
  provider: { baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash' } as AiProvider,
  currentContent: '我只是觉得挺荒唐。',
  recent: [{ role: 'assistant' as const, content: '你是觉得难过吗？' }],
  defaultAction: '给出下一步',
  style: DEFAULT_CONVERSATION_STYLE
};

afterEach(() => {
  vi.useRealTimers();
  stream.mockReset();
});

it('cancels a blocked planner at two seconds without retrying', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  stream.mockImplementation(async function* (args) {
    signal = args.signal;
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    yield { type: 'done' };
  });
  const pending = getAiReplyPlan(input);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await pending).toEqual({ status: 'timeout' });
  expect(signal?.aborted).toBe(true);
  expect(stream).toHaveBeenCalledTimes(1);
  expect(stream.mock.calls[0][0]).toMatchObject({ purpose: 'reply-planning', reasoningEffort: 'none' });
  expect(stream.mock.calls[0][0].webTool).toBeUndefined();
});

it('skips planning when there is only an attachment and no text to interpret', async () => {
  expect(await getAiReplyPlan({ ...input, currentContent: ' ' })).toEqual({ status: 'skipped' });
  expect(stream).not.toHaveBeenCalled();
});

it('uses the normal response flow when there is no earlier text', async () => {
  expect(await getAiReplyPlan({ ...input, recent: [] })).toEqual({ status: 'skipped' });
  expect(stream).not.toHaveBeenCalled();
});

it('accepts an abstention without providing a hint', async () => {
  stream.mockImplementation(async function* () {
    yield { type: 'delta', text: '{"action":"keep"}' };
    yield { type: 'usage', inputTokens: 300, outputTokens: 7 };
  });
  expect(await getAiReplyPlan(input)).toEqual({ status: 'kept', inputTokens: 300, outputTokens: 7 });
});

it('checks the quote against the excerpt actually shown to the planner', async () => {
  const recent = [{ role: 'assistant' as const, content: `开头的第一个选项${'甲'.repeat(400)}已裁掉的片段${'乙'.repeat(400)}最后的第二个选项` }];
  for (const [evidence, status] of [['开头的第一个选项', 'applied'], ['已裁掉的片段', 'invalid']] as const) {
    stream.mockImplementation(async function* () {
      yield { type: 'delta', text: JSON.stringify({ action: 'adjust', evidence, hint: '接着讲第一个选项。' }) };
    });
    expect(await getAiReplyPlan({ ...input, recent })).toEqual(status === 'applied'
      ? { status, hint: '接着讲第一个选项。' }
      : { status });
  }
});

it('requires a user quote before limiting the response to the deliverable', async () => {
  stream.mockImplementation(async function* () {
    yield { type: 'delta', text: '{"action":"adjust","evidence":"这个标题","hint":"沿用前文主语","outputOnlyQuote":"只给标题"}' };
  });
  const currentContent = '帮我改一下这个标题';
  expect(await getAiReplyPlan({ ...input, currentContent, recent: [{ role: 'assistant', content: '建议只给标题' }] })).toEqual({ status: 'applied', hint: '沿用前文主语' });
  expect(await getAiReplyPlan({ ...input, currentContent: `${currentContent}，只给标题` })).toEqual({ status: 'applied', hint: '沿用前文主语', outputOnly: true });
});
