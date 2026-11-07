import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@prisma/client';

/**
 * 记忆审核 AI。钉四件事：解析的防御性、输出必须是用户原话、坏了才回退（返回 null）、默认关闭。
 * 模型调用换成替身，不真的出站；这一层只负责把模型输出变成可信候选，落库决策不归它。
 */
const ctx = vi.hoisted(() => ({
  chunks: [] as string[],
  throws: false,
  // 前 N 趟调用抛错、之后恢复：测「审核失败重试一次」用。
  throwsFirst: 0,
  calls: 0,
  providerThrows: false,
  // 系统配置探针：null = 库里没这一行（走 env 兜底）
  enabledSetting: null as unknown,
  providerSetting: null as unknown
}));

vi.mock('@/lib/ai', () => ({
  streamChatCompletion: async function* () {
    ctx.calls += 1;
    if (ctx.throwsFirst > 0) {
      ctx.throwsFirst -= 1;
      throw new Error('限流');
    }
    if (ctx.throws) throw new Error('模型服务暂时不可用');
    for (const chunk of ctx.chunks) yield { type: 'delta', text: chunk };
  }
}));

vi.mock('@/lib/logger', () => ({
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
}));

vi.mock('@/lib/config', () => ({
  getRawSystemSetting: (key: string) =>
    Promise.resolve(key === 'cognitiveAiMemoryEnabled' ? ctx.enabledSetting : ctx.providerSetting)
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
  ctx.enabledSetting = null;
  ctx.providerSetting = null;
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

describe('aiMemoryExtractionEnabled：后台配置优先，env 兜底', () => {
  it('库里没配置也没设 env 时关闭', async () => {
    const { aiMemoryExtractionEnabled } = await mod();
    expect(await aiMemoryExtractionEnabled()).toBe(false);
  });

  it('库里没配置时回落 env：只有明确的 1 才开', async () => {
    const { aiMemoryExtractionEnabled } = await mod();
    process.env.COGNITIVE_AI_MEMORY = '1';
    expect(await aiMemoryExtractionEnabled()).toBe(true);
    process.env.COGNITIVE_AI_MEMORY = 'true';
    expect(await aiMemoryExtractionEnabled()).toBe(false);
  });

  it('后台配置里开了就开了，不看 env；关了 env 也顶不开', async () => {
    const { aiMemoryExtractionEnabled } = await mod();
    ctx.enabledSetting = true;
    expect(await aiMemoryExtractionEnabled()).toBe(true);
    ctx.enabledSetting = false;
    process.env.COGNITIVE_AI_MEMORY = '1';
    expect(await aiMemoryExtractionEnabled()).toBe(false);
  });
});

describe('reviewTurnWithAI：审核结论就是最终候选，坏了回退 null', () => {
  it('模型给出合法数组时解析返回', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.chunks = ['[{"text":"我住在杭州', '","type":"fact"}]'];
    const got = await reviewTurnWithAI('user-a', '我住在杭州。', [{ text: '我住在杭州', type: 'fact' }], PROVIDER);
    expect(ctx.calls).toBe(1);
    expect(got).toEqual([{ text: '我住在杭州', type: 'fact' }]);
  });

  it('模型返回空数组是结论（这一轮不记），不是失败', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.chunks = ['[]'];
    const got = await reviewTurnWithAI('user-a', '我今天心情还行。', [{ text: '我今天心情还行', type: 'emotion' }], PROVIDER);
    expect(got).toEqual([]);
  });

  it('模型改写了措辞的那条不收：记的必须是用户原话', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.chunks = ['[{"text":"用户偏爱黑咖啡","type":"preference"},{"text":"我喜欢喝黑咖啡","type":"preference"}]'];
    const got = await reviewTurnWithAI('user-a', '我喜欢喝黑咖啡，不加糖。', [], PROVIDER);
    expect(got).toEqual([{ text: '我喜欢喝黑咖啡', type: 'preference' }]);
  });

  it('模型抛错返回 null，不抛给调用方', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.throws = true;
    const got = await reviewTurnWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(got).toBeNull();
  });

  it('模型输出解析不了返回 null', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.chunks = ['我觉得没什么值得记的'];
    const got = await reviewTurnWithAI('user-a', '今天天气不错。', [], PROVIDER);
    expect(got).toBeNull();
  });
});

describe('filterVerbatimCandidates：原话片段判定', () => {
  it('标点与空白差异算同句，改写不算', async () => {
    const { filterVerbatimCandidates } = await mod();
    const content = '我喜欢黑咖啡，不加糖。';
    expect(filterVerbatimCandidates([{ text: '我喜欢黑咖啡', type: 'preference' }], content).kept).toHaveLength(1);
    expect(filterVerbatimCandidates([{ text: '我喜欢黑咖啡。', type: 'preference' }], content).kept).toHaveLength(1);
    expect(filterVerbatimCandidates([{ text: '我爱喝美式', type: 'preference' }], content).kept).toHaveLength(0);
  });

  it(' dropped 计数用于日志', async () => {
    const { filterVerbatimCandidates } = await mod();
    const got = filterVerbatimCandidates(
      [
        { text: '我住在杭州', type: 'fact' },
        { text: '他最近搬去了上海', type: 'fact' }
      ],
      '我住在杭州。'
    );
    expect(got.dropped).toBe(1);
  });
});

describe('isReviewWorthwhile：不为零信息应答花一次模型调用', () => {
  it('寒暄、语气词、纯符号、过短的轮次不问模型', async () => {
    const { isReviewWorthwhile } = await mod();
    for (const text of ['好的', '嗯嗯', '哈哈哈哈哈', '哦哦哦', '谢谢啦', '收到', '知道了', '。。。', '🙂🙂🙂', '行']) {
      expect(isReviewWorthwhile(text)).toBe(false);
    }
  });

  it('有实质内容就值得问，哪怕规则一个候选都没抽到', async () => {
    const { isReviewWorthwhile } = await mod();
    expect(isReviewWorthwhile('我下周要去成都出差，顺便看看那边的办公室。')).toBe(true);
    expect(isReviewWorthwhile('帮我记一下这周的工作安排')).toBe(true);
  });
});
describe('成本计数（§9.6 每轮额外模型调用数）', () => {
  it('一次审核至多两趟调用：失败重试一次，成功只花一次', async () => {
    const m = await mod();
    m.resetAiExtractionCallCount();
    expect(m.aiExtractionCallCountValue()).toBe(0);
    ctx.chunks = ['[]'];
    await m.reviewTurnWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(m.aiExtractionCallCountValue()).toBe(1);
    ctx.throws = true;
    await m.reviewTurnWithAI('user-a', '我住在杭州。', [], PROVIDER);
    // 第一趟失败 + 重试一趟失败 = 2 次成本，然后回退规则。
    expect(m.aiExtractionCallCountValue()).toBe(3);
  });
});

describe('reviewTurnWithAI：重试与「整趟作废」', () => {
  it('第一趟模型错、第二趟成功时取第二趟的结论', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.throwsFirst = 1;
    ctx.chunks = ['[{"text":"我住在杭州","type":"fact"}]'];
    const got = await reviewTurnWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(got).toEqual([{ text: '我住在杭州', type: 'fact' }]);
    expect(ctx.calls).toBe(2);
  });

  it('挑出来的每一条都不是原话＝格式失效，返回 null 让调用方回退规则', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.chunks = ['[{"text":"用户长期居住于杭州","type":"fact"}]'];
    const got = await reviewTurnWithAI('user-a', '我住在杭州。', [{ text: '我住在杭州', type: 'fact' }], PROVIDER);
    expect(got).toBeNull();
  });

  it('一部分不是原话时只丢那几条，结论仍然有效', async () => {
    const { reviewTurnWithAI } = await mod();
    ctx.chunks = ['[{"text":"我住在杭州","type":"fact"},{"text":"他偏爱手冲","type":"preference"}]'];
    const got = await reviewTurnWithAI('user-a', '我住在杭州。', [], PROVIDER);
    expect(got).toEqual([{ text: '我住在杭州', type: 'fact' }]);
  });
});

describe('replaces：审核模型点名推翻哪条旧说法', () => {
  it('给了已有记忆才认 replaces，且 id 必须在集合里', async () => {
    const { parseAiCandidates } = await mod();
    const allowed = new Set(['m-1']);
    expect(
      parseAiCandidates('[{"text":"我不跑步了","type":"fact","replaces":"m-1"}]', allowed)
    ).toEqual([{ text: '我不跑步了', type: 'fact', supersedesId: 'm-1' }]);
    // 编出来的 id 丢掉，但那条候选本身照收。
    expect(parseAiCandidates('[{"text":"我不跑步了","type":"fact","replaces":"m-999"}]', allowed)).toEqual([
      { text: '我不跑步了', type: 'fact' }
    ]);
    // 没给已有记忆（审核路径没开或池子空）时，replaces 一律不认。
    expect(parseAiCandidates('[{"text":"我不跑步了","type":"fact","replaces":"m-1"}]')).toEqual([
      { text: '我不跑步了', type: 'fact' }
    ]);
  });

  it('提示词里带上已有记忆与 id，模型才有东西可指', async () => {
    const { buildReviewUserPrompt } = await mod();
    const prompt = buildReviewUserPrompt('我不跑步了。', [], [{ id: 'm-1', type: 'preference', content: '我现在每天早上跑步三公里' }]);
    expect(prompt).toContain('"id":"m-1"');
    expect(prompt).toContain('我现在每天早上跑步三公里');
    expect(buildReviewUserPrompt('我住在杭州。', [])).not.toContain('已有记忆');
  });
});

describe('resolveMemoryExtractionProvider：指定独立审核模型', () => {
  it('没配置时用默认聊天模型', async () => {
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'default-provider' });
  });

  it('env 配了就用指定的 provider（库里没配置时）', async () => {
    process.env.COGNITIVE_AI_MEMORY_PROVIDER = 'p-review';
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'p-review' });
  });

  it('后台系统配置优先于 env', async () => {
    process.env.COGNITIVE_AI_MEMORY_PROVIDER = 'p-env';
    ctx.providerSetting = 'p-db';
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'p-db' });
  });

  it('指定的取不到（写错/无权）回退默认模型，不抛错', async () => {
    process.env.COGNITIVE_AI_MEMORY_PROVIDER = 'p-gone';
    ctx.providerThrows = true;
    const { resolveMemoryExtractionProvider } = await mod();
    expect(await resolveMemoryExtractionProvider('user-a')).toEqual({ id: 'default-provider' });
  });
});
