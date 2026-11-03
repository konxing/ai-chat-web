import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilitiesOf, pickCapableProvider, providerInputSchema } from '@/lib/providers';

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
