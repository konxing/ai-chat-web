import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 向量臂的出站那一趟。这里要钉住的五件事，多半是「对面不老实」的形状：
 * 一、包不整吞（复用 chat 那条路上同一个 `readBodyCapped`，不另写一份会漂移的复刻）；
 * 二、回来的数组必须是能算余弦的数，且不能是零向量——零向量跟谁都是 0 分，
 *     存下来等于一条悄悄坏掉的记忆；
 * 三、明文向量只在内存里活一瞬间，落库前必须过 `encryptBuffer`，AAD 绑到字段名，
 *     跟正文密文不是同一串字节；
 * 四、维度不硬编码成某个常数，而是写进行上——读侧只跟同模型同维度的行算余弦；
 * 五、挑 provider 的 where 仍然限定「本人私有 + 全局」，别人的私有端点不进入候选。
 */
const ctx = vi.hoisted(() => ({
  fetches: [] as Array<{ url: string; init: Record<string, unknown> }>,
  wheres: [] as Record<string, unknown>[],
  providers: [] as Array<Record<string, unknown>>,
  response: { ok: true, status: 200, contentType: 'application/json', body: '[]' }
}));

vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return { ...actual, decryptProviderKey: () => 'secret-key' };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    aiProvider: {
      findMany: (args: { where: Record<string, unknown> }) => {
        ctx.wheres.push(args.where);
        return Promise.resolve(ctx.providers);
      }
    }
  }
}));

vi.mock('@/lib/ssrf', () => ({
  resolveProviderTarget: (baseUrl: string) => Promise.resolve({ url: new URL(baseUrl), baseUrl }),
  joinApiPath: (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, '')}${path}`,
  safeFetch: (_target: unknown, url: string, init: Record<string, unknown>) => {
    ctx.fetches.push({ url, init });
    const text = ctx.response.body;
    return Promise.resolve({
      response: {
        ok: ctx.response.ok,
        status: ctx.response.status,
        headers: { get: () => ctx.response.contentType },
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: () => {
                if (sent) return Promise.resolve({ done: true, value: undefined });
                sent = true;
                return Promise.resolve({ done: false, value: new TextEncoder().encode(text) });
              },
              releaseLock: () => undefined
            };
          }
        }
      },
      close: () => Promise.resolve()
    });
  }
}));

import { decryptBuffer, encryptBuffer } from '@/lib/crypto';
import { cognitiveAad, legacyCognitiveAad } from '@/lib/cognitive/aad';
import { embedMemoryText, packVector, vectorFromRow } from '@/lib/cognitive/embedding';

const USER = 'user-me';

/** 向量的封口只有一个来源：这一族的形状由 aad.ts 说了算，测试不另写一份可能漂移的字面量。 */
const vectorAad = (memoryId: string, userId = USER) =>
  cognitiveAad({ purpose: 'memory-vector', userId, recordId: memoryId, fieldName: 'embeddingCiphertext' });
const legacyVectorAad = (memoryId: string, userId = USER) =>
  legacyCognitiveAad({ purpose: 'memory-vector', userId, recordId: memoryId, fieldName: 'embeddingCiphertext' });

function embeddingProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-emb',
    ownerType: 'GLOBAL',
    userId: null,
    name: '向量端点',
    baseUrl: 'https://api.example.com',
    modelId: 'embed-v1',
    capabilities: ['embedding'],
    enabled: true,
    isDefault: true,
    apiKeyCiphertext: 'zzz',
    ...overrides
  };
}

function stub(json: unknown, options: { ok?: boolean; status?: number } = {}) {
  ctx.response = {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    contentType: 'application/json',
    body: JSON.stringify(json)
  };
}

function header(init: Record<string, unknown>, name: string): string | undefined {
  const raw = init.headers as Record<string, string>;
  return raw[name] ?? Object.entries(raw).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

beforeEach(() => {
  ctx.fetches.length = 0;
  ctx.wheres.length = 0;
  ctx.providers = [embeddingProvider()];
  stub({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
});

describe('往 embedding 端点发的那一趟', () => {
  it('请求打到 /embeddings，包体只带模型名和要算的那句话', async () => {
    await embedMemoryText(USER, 'mem-1', '我在杭州住');
    expect(ctx.fetches).toHaveLength(1);
    expect(ctx.fetches[0]!.url).toBe('https://api.example.com/embeddings');
    expect(JSON.parse(String(ctx.fetches[0]!.init.body))).toEqual({ model: 'embed-v1', input: '我在杭州住' });
    expect(header(ctx.fetches[0]!.init, 'authorization')).toBe('Bearer secret-key');
  });

  it('params.embeddingModel 覆盖出站的模型名：对话模型和向量模型常常不是同一个', async () => {
    ctx.providers = [
      embeddingProvider({ modelId: 'ark-code-latest', params: { embeddingModel: 'doubao-embedding-vision' } })
    ];
    await embedMemoryText(USER, 'mem-1', '我在杭州住');
    expect(JSON.parse(String(ctx.fetches[0]!.init.body))).toEqual({
      model: 'doubao-embedding-vision',
      input: '我在杭州住'
    });
  });

  it('行上记的模型名是真正问过的那一个：维度校验和读侧同模型判定都靠它', async () => {
    ctx.providers = [
      embeddingProvider({ modelId: 'ark-code-latest', params: { embeddingModel: 'doubao-embedding-vision' } })
    ];
    const stored = await embedMemoryText(USER, 'mem-1', '我在杭州住');
    expect(stored!.model).toBe('doubao-embedding-vision');
  });

  it('没配 embeddingModel 时退回 modelId——但不许凭空造一个默认模型名', async () => {
    ctx.providers = [embeddingProvider({ params: null })];
    const stored = await embedMemoryText(USER, 'mem-1', '我在杭州住');
    expect(JSON.parse(String(ctx.fetches[0]!.init.body))).toEqual({ model: 'embed-v1', input: '我在杭州住' });
    expect(stored!.model).toBe('embed-v1');
  });

  it('候选范围仍是「本人私有加全局」，且只要启用的', async () => {
    await embedMemoryText(USER, 'mem-1', '我在杭州住');
    expect(ctx.wheres[0]).toMatchObject({ enabled: true });
    expect(ctx.wheres[0]!.OR).toEqual([
      { ownerType: 'GLOBAL' },
      { ownerType: 'USER', userId: USER }
    ]);
  });

  it('拿回来的向量按字段名加密，读回来是同一串数', async () => {
    const vector = [0.25, -0.5, 0.75];
    stub({ data: [{ embedding: vector }] });
    const stored = await embedMemoryText(USER, 'mem-1', '我在杭州住');
    expect(stored).not.toBeNull();
    expect(stored!.model).toBe('embed-v1');
    expect(vectorFromRow(stored!.ciphertext, USER, 'mem-1')).toHaveLength(3);
    expect(Buffer.from(stored!.ciphertext).includes(Buffer.from(packVector(vector)))).toBe(false);
    expect([...vectorFromRow(stored!.ciphertext, USER, 'mem-1')]).toEqual(vector);
  });

  it('写侧封的是新口径（带字段名），旧配方打不开它', async () => {
    const vector = [0.5, -0.25];
    stub({ data: [{ embedding: vector }] });
    const stored = await embedMemoryText(USER, 'mem-1', '我在杭州住');
    const bytes = Buffer.from(stored!.ciphertext);

    // 上面那条「读得回来」拦不住写侧悄悄退回旧封口——回退会替它蒙过去。
    // 这一条才钉得住：同一串字节，认新口径，不认旧口径。
    expect(decryptBuffer(bytes, vectorAad('mem-1'))).toEqual(Buffer.from(packVector(vector)));
    expect(() => decryptBuffer(bytes, legacyVectorAad('mem-1'))).toThrow();
  });

  it('库里旧口径封的向量行，读侧靠回退仍然解得开', () => {
    const legacyRow = encryptBuffer(packVector([4, 5]), legacyVectorAad('mem-old'));

    expect([...vectorFromRow(legacyRow, USER, 'mem-old')]).toEqual([4, 5]);
  });

  it('AAD 绑到记忆 id：换个人拿同一串密文解不出同一个向量', () => {
    const mine = encryptBuffer(packVector([1, 2, 3]), vectorAad('mem-1'));

    expect(() => decryptBuffer(mine, vectorAad('mem-1', 'user-other'))).toThrow();
    expect([...vectorFromRow(mine, USER, 'mem-1')]).toEqual([1, 2, 3]);
  });

  it('零向量不算有效：它跟谁都打 0 分', async () => {
    stub({ data: [{ embedding: [0, 0, 0] }] });
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/零向量/);
  });

  it('数组里混进非数字就当失败，不让 NaN 进余弦', async () => {
    stub({ data: [{ embedding: [0.1, 'x', null, Number.NaN] }] });
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/非数字/);
  });

  it('响应里没有 data[0].embedding 就当失败', async () => {
    stub({ data: [] });
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/维度/);
    stub({});
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/维度/);
  });

  it('HTTP 非 2xx 直接失败，不去解析包体', async () => {
    stub({ error: { message: 'no' } }, { ok: false, status: 404 });
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/HTTP 404/);
    expect(ctx.fetches).toHaveLength(1);
  });

  it('维度过大也挡下：正文撑得住不代表那一串数能用', async () => {
    stub({ data: [{ embedding: new Array(20_000).fill(0.001) }] });
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/维度/);
  });

  it('200 但回来的不是 JSON 也当失败，不让半个响应溜进加密那一步', async () => {
    stub({ data: [{ embedding: [1, 2] }] });
    ctx.response.body = '<html>登录页</html>';
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/不是 JSON/);
  });

  it('一条勾了 embedding 的 provider 都没有就报没有，不拿文本模型凑数', async () => {
    ctx.providers = [embeddingProvider({ capabilities: ['text'] })];
    await expect(embedMemoryText(USER, 'mem-1', '我在杭州住')).rejects.toThrow(/语义向量/);
    expect(ctx.fetches).toHaveLength(0);
  });
});
