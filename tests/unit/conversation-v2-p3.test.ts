import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  saved: [] as Array<Record<string, unknown>>,
  settings: new Map<string, unknown>()
}));
vi.mock('@/lib/cognitive/conversation/style/style-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cognitive/conversation/style/style-profile')>();
  return {
    ...actual,
    setConversationStyle: (_u: string, style: Record<string, unknown>) => { ctx.saved.push(style); return Promise.resolve(style); },
    resetConversationStyle: () => Promise.resolve({})
  };
});
vi.mock('@/lib/config', () => ({
  getRawSystemSetting: (k: string) => Promise.resolve(ctx.settings.has(k) ? ctx.settings.get(k) : null)
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemConfig: {
      upsert: ({ where, create, update }: { where: { key: string }; create: { key: string; value: unknown }; update: { value: unknown } }) => {
        ctx.settings.set(where.key, update.value ?? create.value);
        return Promise.resolve({ key: where.key, value: update.value ?? create.value });
      },
      deleteMany: ({ where }: { where: { key: { in: string[] } } }) => {
        for (const k of where.key.in) ctx.settings.delete(k);
        return Promise.resolve({ count: 0 });
      }
    }
  }
}));

import { extractStyleFeedback, learnConversationPreference, attributeMechanicalFeedback } from '@/lib/cognitive/conversation/learning/preference-extractor';
import { getActivePromptVersion, addCandidatePromptVersion, activatePromptVersion } from '@/lib/cognitive/conversation/prompts/prompt-version';

describe('P3 偏好范围：临时不污染长期（F-08）', () => {
  it('"这次不要列点" → TEMPORARY，不持久化', async () => {
    ctx.saved.length = 0;
    const f = extractStyleFeedback('这次不要列点');
    expect(f?.scope).toBe('TEMPORARY');
    expect(await learnConversationPreference('u', '这次不要列点')).toBe(false);
    expect(ctx.saved.length).toBe(0);
  });

  it('"以后不要列点" → GLOBAL，持久化', async () => {
    ctx.saved.length = 0;
    const f = extractStyleFeedback('以后不要列点');
    expect(f?.scope).toBe('GLOBAL');
    expect(await learnConversationPreference('u', '以后不要列点')).toBe(true);
    expect(ctx.saved.length).toBe(1);
  });

  it('含糊"不要列点"（无持续标记）降级 CONTEXT，不自动持久化', async () => {
    ctx.saved.length = 0;
    const f = extractStyleFeedback('不要列点');
    expect(f?.scope).toBe('CONTEXT');
    expect(await learnConversationPreference('u', '不要列点')).toBe(false);
  });

  it('"以后技术问题先讲原理" → GLOBAL 带技术范围', () => {
    const f = extractStyleFeedback('以后技术问题先讲原理');
    expect(f?.scope).toBe('GLOBAL');
    expect(f?.topic).toBe('技术');
  });
});

describe('P3 反馈归因', () => {
  it('太机械区分意图/追问/密度/文风', () => {
    expect(attributeMechanicalFeedback('你理解错了，太机械')).toBe('intent');
    expect(attributeMechanicalFeedback('别总问我，太机械')).toBe('over_question');
    expect(attributeMechanicalFeedback('太复杂了，简单点')).toBe('density');
    expect(attributeMechanicalFeedback('语气太机械')).toBe('style');
  });
});

describe('P3 版本适用性生效（F-09）', () => {
  it('applicableMode 不匹配时不选该版本', async () => {
    ctx.settings.clear();
    const v = await addCandidatePromptVersion({ content: '技术专用', applicableMode: 'TECHNICAL_EXPERT' });
    await activatePromptVersion(v.id);
    expect(await getActivePromptVersion({ mode: 'NATURAL_CHAT' })).toBeNull();
    expect((await getActivePromptVersion({ mode: 'TECHNICAL_EXPERT' }))?.id).toBe(v.id);
  });
});
