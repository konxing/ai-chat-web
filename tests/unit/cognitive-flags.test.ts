import { afterEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ settings: new Map<string, unknown>() }));

vi.mock('@/lib/config', () => ({
  getRawSystemSetting: (key: string) => Promise.resolve(ctx.settings.has(key) ? ctx.settings.get(key) : null)
}));

import {
  consolidationEnabled,
  decayRankingEnabled,
  hybridRetrievalEnabled,
  sourceDiveEnabled,
  strictRelevanceEnabled
} from '@/lib/cognitive/cognitive-flags';

afterEach(() => {
  ctx.settings.clear();
  delete process.env.COGNITIVE_RETRIEVAL_V2;
  delete process.env.COGNITIVE_HYBRID_RETRIEVAL;
  delete process.env.COGNITIVE_MEMORY_DECAY;
  delete process.env.COGNITIVE_MEMORY_CONSOLIDATION;
  delete process.env.COGNITIVE_SOURCE_DIVE;
});

describe('合并开关：后台配置优先、环境变量兜底', () => {
  it('检索增强一个开关同时控制四项', async () => {
    ctx.settings.set('cognitiveRetrievalEnhanced', true);
    expect(await strictRelevanceEnabled()).toBe(true);
    expect(await hybridRetrievalEnabled()).toBe(true);
    expect(await decayRankingEnabled()).toBe(true);
    expect(await consolidationEnabled()).toBe(true);
  });

  it('后台显式关时，即使 env 开着也关', async () => {
    ctx.settings.set('cognitiveRetrievalEnhanced', false);
    process.env.COGNITIVE_RETRIEVAL_V2 = '1';
    expect(await strictRelevanceEnabled()).toBe(false);
  });

  it('后台没配置时各自回落 env（老部署不变）', async () => {
    process.env.COGNITIVE_RETRIEVAL_V2 = '1';
    expect(await strictRelevanceEnabled()).toBe(true);
    expect(await hybridRetrievalEnabled()).toBe(false);
  });

  it('上下文增强默认开启记忆溯源', async () => {
    expect(await sourceDiveEnabled()).toBe(true);
  });

  it('后台关闭上下文增强时关闭记忆溯源', async () => {
    ctx.settings.set('cognitiveContextEnhanced', false);
    expect(await sourceDiveEnabled()).toBe(false);
  });
});
