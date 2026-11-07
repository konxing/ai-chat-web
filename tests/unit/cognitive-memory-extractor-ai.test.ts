import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@prisma/client';

/**
 * AI 二级抽取（Phase 2）。钉三件事：解析的防御性、坏了就回退（返回 null）、默认关闭。
 * 模型调用换成替身，不真的出站；这一层只负责把模型输出变成可信候选，落库决策不归它。
 */
const ctx = vi.hoisted(() => ({
  chunks: [] as string[],
  throws: false,
  calls: 0,
  providerThrows: false
}));

vi.mock('@/lib/ai', () => ({
  streamChatCompletion: async function* () {
    ctx.calls += 1;
    if (ctx.throws) throw new Error('模型服务暂时不可用');
    for (const chunk of ctx.chunks) yield { type: 'delta', text: chunk };
  }
}));

vi.mock('@/lib/logger', () => ({
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
}));

vi.mock('@/lib/providers', () => ({
  getProviderForUser: (providerId: string) =>
    ctx.providerThrows ? Promise.reject(new Error('provider not found')) : Promise.resolve({ id: providerId }),
  resolveDefaultProvider: () => Promise.resolve({ id: 'default-provider' })
}));

const PROVIDER = { id: 'p-1', modelId: 'test' } as AiProvider;

async function mod() {
  return await import('@/lib/cognitive/memory-extractor-ai');
}

afterEach(() => {
  ctx.chunks = [];
  ctx.throws = false;
  ctx.calls = 0;
  ctx.providerThrows = false;
  delete process.env.COGNITIVE_AI_MEMORY;
  delete process.env.COGNITIVE_AI_MEMORY_PROVIDER;
  void mod().then((m) => m.resetAiExtractionCallCount());
});

describe('parseAiCandidates：防御性解析', () => {
  it('合法 JSON 数组逐条收下，类型校验、去重', async () => {
    const { parseAiCandidates } = await mod();
    const got = parseAiCandidates('[{"text":"我住在杭州","type":"fact"},{"text":"我住在杭州","type":"fact"},{"text":"我喜欢黑咖啡","type":"preference"}]');
    expect(got).toEqual([
      { text: '我住在杭州', type: 'fact' },
      { text: '我喜欢黑咖啡', type: 'preference' }
    ]);
  });

  it('剥掉 ```json 包裹和前后解释文字', async () => {
    const { parseAiCandidates } = await mod();
    const got = parseAiCandidates('好的，结果如下：\n```json\n[{"text":"我在用 ESP32","type":"project"}]\n```\n希望有帮助');
    expect(got).toEqual([{ text: '我在用 ESP32', type: 'project' }]);
  });

  it('非法类型、问句、空数组元素都剔除', async () => {
    const { parseAiCandidates } = await mod();
    const got = parseAiCandidates('[{"text":"我喜欢什么咖啡？","type":"preference"},{"text":"我住杭州","type":"unknown"},{"text":"我养了猫","type":"fact"}]');
    expect(got).toEqual([{ text: '我养了猫', type: 'fact' }]);
  });

  it('解析不出合法数组返回 null（调用方据此回退规则）', async () => {
    const { parseAiCandidates } = await mod();
    expect(parseAiCandidates('抱歉我无法判断')).toBeNull();
    expect(parseAiCandidates('[broken json')).toBeNull();
    expect(parseAiCandidates('{"text":"不是数组","type":"fact"}')).toBeNull();
  });

  it('空数组是合法结果（模型认为没什么值得记）', async () => {
    const { parseAiCandidates } = await mod();
    expect(parseAiCandidates('[]')).toEqual([]);
  });
});

describe('aiMemoryExtractionEnabled：默认关', () => {
  it('没设 env 时关闭', async () => {
    const { aiMemoryExtractionEnabled } = await mod();
    expect(aiMemoryExtractionEnabled()).toBe(false);
  });

  it('只有明确的 1 才开', async () => {
    const { aiMemoryExtractionEnabled } = await mod();
    process.env.COGNITIVE_AI_MEMORY = '1';
    expect(aiMemoryExtractionEnabled()).toBe(true);
    process.env.COGNITIVE_AI_MEMORY = 'true';
    expect(aiMemoryExtractionEnabled()).toBe(false);
  });
});

describe('refineCandidatesWithAI：调一次模型，坏了回退 null', () => {
  it('模型给出合法数组时解析返回', async () => {
    const { refineCandidatesWithAI } = await mod();
    ctx.chunks = ['[{"text":"我住在杭州', '","type":"fact"}]'];
    const got = await refineCandidatesWithAI('user-a', '我住在杭州。', [{ text: '我住在杭州', type: 'fact' }], PROVIDER);
    expect(ctx.calls).toBe(1);
    expect(got).toEqual([{ text: '我住在杭州', type: 'fact' }]);
  });

  it('模型抛错返回 null，不抛给调用方', async () => {
    const { refineCandidatesWithAI } = await mod();
    ctx.throws = true;
    const got = await refineCandidatesWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(got).toBeNull();
  });

  it('模型输出解析不了返回 null', async () => {
    const { refineCandidatesWithAI } = await mod();
    ctx.chunks = ['我觉得没什么值得记的'];
    const got = await refineCandidatesWithAI('user-a', '今天天气不错。', [], PROVIDER);
    expect(got).toBeNull();
  });
});
describe('成本计数（§9.6 每轮额外模型调用数）', () => {
  it('每次 refine 记一次，模型抛错也算（成本已发生）', async () => {
    const m = await mod();
    m.resetAiExtractionCallCount();
    expect(m.aiExtractionCallCountValue()).toBe(0);
    ctx.chunks = ['[]'];
    await m.refineCandidatesWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(m.aiExtractionCallCountValue()).toBe(1);
    ctx.throws = true;
    await m.refineCandidatesWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(m.aiExtractionCallCountValue()).toBe(2);
  });
});

describe('resolveMemoryExtractionProvider：指定独立审核模型', () => {
  it('没配 COGNITIVE_AI_MEMORY_PROVIDER 时用默认聊天模型', async () => {
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'default-provider' });
  });

  it('配了就用指定的 provider', async () => {
    process.env.COGNITIVE_AI_MEMORY_PROVIDER = 'p-review';
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'p-review' });
  });

  it('指定的取不到（写错/无权）回退默认模型，不抛错', async () => {
    process.env.COGNITIVE_AI_MEMORY_PROVIDER = 'p-gone';
    ctx.providerThrows = true;
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'default-provider' });
  });
});
