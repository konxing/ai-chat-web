import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilitiesOf, maskProvider, pickCapableProvider, providerInputSchema } from '@/lib/providers';

/**
 * 认知层要往端点发 embeddings 请求，前提是「哪条 provider 管向量」这件事有个说法。
 * 说法沿用语音转写那一条（`src/app/api/stt/route.ts:41`）：能力勾了才算，
 * 谁能用、启没启用仍由 SQL 的 where 决定，挑法本身只是个纯函数。
 */
function row(capabilities: unknown, overrides: Record<string, unknown> = {}) {
  return { id: 'p', name: 'p', capabilities, ...overrides } as never;
}

describe('embedding 能力的注册', () => {
  it('能力清单里有 embedding', () => {
    expect(CAPABILITIES).toContain('embedding');
  });

  it('存进去的能力读回来不丢', () => {
    const provider = row(['text', 'embedding']) as never as Parameters<typeof capabilitiesOf>[0];
    expect(capabilitiesOf(provider)).toEqual(['text', 'embedding']);
  });

  it('五种能力全勾也收', () => {
    const parsed = providerInputSchema.safeParse({
      name: '向量端点',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      modelId: 'embed-v1',
      capabilities: ['text', 'vision', 'files', 'audio', 'embedding']
    });
    expect(parsed.success).toBe(true);
  });

  it('清单外的能力照旧被拒', () => {
    const parsed = providerInputSchema.safeParse({
      name: 'n',
      baseUrl: 'https://api.example.com',
      modelId: 'm',
      capabilities: ['embedding', 'video']
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * 向量臂的模型名从哪来（片 f 的第一颗钉子）。`AiProvider` 上没有第二个模型字段，
 * 一支迁移换一个约定不划算，所以约定写在 `params` 里：`embeddingModel` 缺省时退回
 * `modelId`，但**绝不给默认模型名**——我们看不见对面 host 上到底有什么，猜一个名字
 * 等于把「探针失败」和「我们猜错」混成同一件事。
 */
describe('embedding 用哪个模型名', () => {
  const base = {
    name: '向量端点',
    baseUrl: 'https://api.example.com',
    modelId: 'ark-code-latest'
  };

  it('请求体里带 params.embeddingModel：schema 不许把它当陌生键拒掉', () => {
    const parsed = providerInputSchema.safeParse({
      ...base,
      capabilities: ['text', 'embedding'],
      params: { embeddingModel: 'doubao-embedding-vision' }
    });
    expect(parsed.success, JSON.stringify((parsed as { error?: { issues?: unknown } }).error?.issues ?? null)).toBe(true);
  });

  it('藏起来的视图里这个键还在：管理员存的模型名，读回来必须看得见', () => {
    const masked = maskProvider({
      id: 'p-1',
      ownerType: 'GLOBAL',
      userId: null,
      name: '向量端点',
      baseUrl: 'https://api.example.com',
      modelId: 'ark-code-latest',
      capabilities: ['text', 'embedding'],
      params: { embeddingModel: 'doubao-embedding-vision' },
      enabled: true,
      isDefault: false,
      apiKeyCiphertext: '',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z')
    } as never);
    expect(masked.params).toMatchObject({ embeddingModel: 'doubao-embedding-vision' });
  });

  it('空串不是模型名：宁缺勿滥，退回 modelId 也比发一个空 model 强', () => {
    const parsed = providerInputSchema.safeParse({
      ...base,
      capabilities: ['embedding'],
      params: { embeddingModel: '' }
    });
    expect(parsed.success).toBe(false);
  });
});

describe('按能力挑 provider', () => {
  it('勾了 embedding 的那一条才入选，按传入顺序取第一条', () => {
    const picked = pickCapableProvider(
      [row(['text']), row(['embedding'])],
      'embedding'
    );
    expect(picked).toEqual(row(['embedding']));
  });

  it('一条都没勾就返回 null，不拿文本模型凑数', () => {
    expect(pickCapableProvider([row(['text']), row(['vision'])], 'embedding')).toBeNull();
  });

  it('库里存的是乱七八糟的值时按没勾处理', () => {
    expect(pickCapableProvider([row(['video']), row(null)], 'embedding')).toBeNull();
  });

  it('空表返回 null', () => {
    expect(pickCapableProvider([], 'embedding')).toBeNull();
  });
});
