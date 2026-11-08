import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ saved: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/cognitive/conversation/style/style-profile', () => ({
  setConversationStyle: (_userId: string, style: Record<string, unknown>) => {
    ctx.saved.push(style);
    return Promise.resolve(style);
  }
}));

import { extractStyleFeedback, learnConversationPreference } from '@/lib/cognitive/conversation/learning/preference-extractor';

describe('extractStyleFeedback：只认明确反馈，区分范围', () => {
  it('"以后不要列点" → GLOBAL 结构最小', () => {
    const f = extractStyleFeedback('以后不要每次都列这么多点');
    expect(f?.scope).toBe('GLOBAL');
    expect(f?.adjustments.structure).toBe('minimal');
  });

  it('"这次先给结论" → TEMPORARY 不持久化', () => {
    const f = extractStyleFeedback('这次先给结论，不用展开');
    expect(f?.scope).toBe('TEMPORARY');
  });

  it('"主动指出我的错误" → GLOBAL 提高主动思考（不是无条件赞同）', () => {
    const f = extractStyleFeedback('我希望你可以主动指出我的错误');
    expect(f?.scope).toBe('GLOBAL');
    expect(f?.adjustments.proactivity).toBe('high');
  });

  it('普通聊天不产生偏好候选', () => {
    expect(extractStyleFeedback('今天天气不错')).toBeNull();
    expect(extractStyleFeedback('我喜欢喝咖啡')).toBeNull();
  });
});

describe('learnConversationPreference：只持久化 GLOBAL', () => {
  it('GLOBAL 反馈写入风格', async () => {
    ctx.saved.length = 0;
    const ok = await learnConversationPreference('u1', '以后不要列点');
    expect(ok).toBe(true);
    expect(ctx.saved.length).toBe(1);
  });

  it('TEMPORARY 反馈不写库', async () => {
    ctx.saved.length = 0;
    const ok = await learnConversationPreference('u1', '这次简单一点');
    expect(ok).toBe(false);
    expect(ctx.saved.length).toBe(0);
  });

  it('无反馈不写库', async () => {
    ctx.saved.length = 0;
    const ok = await learnConversationPreference('u1', '你好');
    expect(ok).toBe(false);
    expect(ctx.saved.length).toBe(0);
  });
});
