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
  recent: [],
  constraints: [],
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
