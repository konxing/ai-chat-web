import { randomUUID } from 'node:crypto';
import type { AiProvider, ProviderOwner } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma';
import { decryptString, encryptString } from './crypto';
import { ApiError } from './http';
import { resolveProviderTarget, safeFetch, joinApiPath } from './ssrf';
import { log } from './logger';

export const CAPABILITIES = ['text', 'vision', 'files', 'audio', 'embedding'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * 半角字符检查：Base URL 和模型 ID 只能出现可见 ASCII。
 *
 * 起因是真实故障——中文输入法把 `:` 打成全角 `：`，`nvidia/nemotron-3.5-super-vl：free`
 * 存进去后 OpenRouter 直接回 400「not a valid model ID」，界面只有一句
 * 「模型服务返回错误（HTTP 400）」，看不出哪里错。保存时就拦住比事后猜快得多。
 *
 * 这里只拒绝、不自动改写：全角冒号是明确的手误，但把任何非 ASCII 静默转成半角
 * 会掩盖真正的拼错（比如把 `l` 打成 `｜`），用户应该看到自己写了什么。
 */
export function firstNonHalfWidth(value: string): string | null {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return char;
  }
  return null;
}

function halfWidthField(label: string, max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => firstNonHalfWidth(value) === null, (value) => {
      const bad = firstNonHalfWidth(value);
      return {
        message: `${label} 含非半角字符「${bad === ' ' ? '空格' : bad}」，请只用英文半角字符（中文输入法常把 : 打成 ：）`
      };
    });
}

export const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  baseUrl: halfWidthField('Base URL', 512),
  apiKey: z.string().trim().min(1).max(500).optional(),
  modelId: halfWidthField('模型 ID', 128),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(5),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(64000).optional(),
      // 向量臂用的模型名。`AiProvider` 上没有第二个模型字段，所以约定放在这里；
      // 空串不收，缺省时由 `embedding.ts` 退回 modelId——**不给默认模型名**。
      embeddingModel: halfWidthField('向量模型 ID', 128).optional()
    })
    .strict()
    .optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false)
});

export type ProviderInput = z.infer<typeof providerInputSchema>;

/** provider 上那几个可选参数；`embeddingModel` 是向量臂的模型名，其余走对话。 */
export type ProviderParams = { temperature?: number; maxTokens?: number; embeddingModel?: string };

export interface PublicProvider {
  id: string;
  ownerType: ProviderOwner;
  name: string;
  baseUrl: string;
  modelId: string;
  capabilities: Capability[];
  params: ProviderParams | null;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

function normalizeCapabilities(value: unknown): Capability[] {
  const list = Array.isArray(value) ? value : [];
  const out = list.filter((v): v is Capability => CAPABILITIES.includes(v as Capability));
  return out.length ? Array.from(new Set(out)) : ['text'];
}

function normalizeParams(value: unknown): ProviderParams | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const out: ProviderParams = {};
  if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) {
    out.temperature = raw.temperature;
  }
  if (typeof raw.maxTokens === 'number' && raw.maxTokens >= 1 && raw.maxTokens <= 64000) {
    out.maxTokens = Math.floor(raw.maxTokens);
  }
  if (typeof raw.embeddingModel === 'string' && raw.embeddingModel.trim()) {
    out.embeddingModel = raw.embeddingModel.trim();
  }
  return Object.keys(out).length ? out : null;
}

/** 向量臂真正问的那个模型名：`params.embeddingModel` 优先，缺省退回对话模型。 */
export function embeddingModelOf(provider: {
  modelId: string;
  params?: unknown;
}): string {
  const params = normalizeParams(provider.params);
  return params?.embeddingModel ?? provider.modelId;
}

export function encryptProviderKey(providerId: string, apiKey: string): string {
  return encryptString(apiKey, `provider-key:${providerId}`);
}

export function decryptProviderKey(provider: Pick<AiProvider, 'id' | 'apiKeyCiphertext'>): string {
  return decryptString(provider.apiKeyCiphertext, `provider-key:${provider.id}`);
}

export function maskProvider(provider: AiProvider): PublicProvider {
  return {
    id: provider.id,
    ownerType: provider.ownerType,
    name: provider.name,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    capabilities: normalizeCapabilities(provider.capabilities),
    params: normalizeParams(provider.params),
    enabled: provider.enabled,
    isDefault: provider.isDefault,
    hasApiKey: provider.apiKeyCiphertext.length > 0,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString()
  };
}

export async function validateProvider(input: ProviderInput): Promise<void> {
  try {
    await resolveProviderTarget(input.baseUrl);
  } catch (err) {
    if (err instanceof ApiError) throw new ApiError(400, 'UNSAFE_URL', err.message);
    throw err;
  }
}

export async function createProvider(
  owner: { type: ProviderOwner; userId?: string | null },
  input: ProviderInput
): Promise<AiProvider> {
  await validateProvider(input);
  const parsed = providerInputSchema.parse(input);
  if (!parsed.apiKey) throw new ApiError(400, 'API_KEY_REQUIRED', '请填写 API Key');
  const id = randomUUID();
  const result = await prisma.$transaction(async (tx) => {
    if (parsed.isDefault) {
      await tx.aiProvider.updateMany({
        where: { ownerType: owner.type, userId: owner.userId ?? null, isDefault: true },
        data: { isDefault: false }
      });
    }
    return tx.aiProvider.create({
      data: {
        id,
        ownerType: owner.type,
        userId: owner.userId ?? null,
        name: parsed.name,
        baseUrl: parsed.baseUrl.replace(/\/+$/, ''),
        apiKeyCiphertext: encryptProviderKey(id, parsed.apiKey!),
        modelId: parsed.modelId,
        capabilities: parsed.capabilities,
        params: parsed.params ?? undefined,
        enabled: parsed.enabled,
        isDefault: parsed.isDefault
      }
    });
  });
  return result;
}

export async function updateProvider(
  provider: AiProvider,
  input: Partial<ProviderInput>
): Promise<AiProvider> {
  if (input.baseUrl) await validateProvider({ ...providerInputSchema.parse({ ...minimalInput(provider), ...input }) } as ProviderInput);
  const parsed = providerInputSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    if (parsed.isDefault) {
      await tx.aiProvider.updateMany({
        where: {
          ownerType: provider.ownerType,
          userId: provider.userId,
          isDefault: true,
          id: { not: provider.id }
        },
        data: { isDefault: false }
      });
    }
    return tx.aiProvider.update({
      where: { id: provider.id },
      data: {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl.replace(/\/+$/, '') } : {}),
        ...(parsed.apiKey ? { apiKeyCiphertext: encryptProviderKey(provider.id, parsed.apiKey) } : {}),
        ...(parsed.modelId !== undefined ? { modelId: parsed.modelId } : {}),
        ...(parsed.capabilities !== undefined ? { capabilities: parsed.capabilities } : {}),
        ...(parsed.params !== undefined ? { params: parsed.params ?? undefined } : {}),
        ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
        ...(parsed.isDefault !== undefined ? { isDefault: parsed.isDefault } : {})
      }
    });
  });
}

function minimalInput(provider: AiProvider): ProviderInput {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    capabilities: normalizeCapabilities(provider.capabilities),
    params: normalizeParams(provider.params) ?? undefined,
    enabled: provider.enabled,
    isDefault: provider.isDefault
  };
}

export async function listProvidersForUser(userId: string): Promise<PublicProvider[]> {
  const rows = await prisma.aiProvider.findMany({
    where: {
      enabled: true,
      OR: [{ ownerType: 'GLOBAL' }, { ownerType: 'USER', userId }]
    },
    orderBy: [{ ownerType: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }]
  });
  return rows.map(maskProvider);
}

export async function listUserProviders(userId: string): Promise<PublicProvider[]> {
  const rows = await prisma.aiProvider.findMany({
    where: { ownerType: 'USER', userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
  });
  return rows.map(maskProvider);
}

export async function listGlobalProviders(): Promise<PublicProvider[]> {
  const rows = await prisma.aiProvider.findMany({
    where: { ownerType: 'GLOBAL' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
  });
  return rows.map(maskProvider);
}

export async function getProviderForUser(providerId: string, userId: string): Promise<AiProvider> {
  const provider = await prisma.aiProvider.findFirst({
    where: {
      id: providerId,
      enabled: true,
      OR: [{ ownerType: 'GLOBAL' }, { ownerType: 'USER', userId }]
    }
  });
  if (!provider) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型不存在或不可用');
  return provider;
}

export async function resolveDefaultProvider(userId: string): Promise<AiProvider> {
  // 四级优先级一次查完：候选 findMany 与配置 findUnique 并行，挑法与原来逐级 findFirst
  // 完全一致（用户自己的默认 → 配置指定的全局 → 标了默认的全局 → 最早创建的全局）。
  // 候选范围仍由 where 限定成本人的私有模型加全局模型，不会因为合并查询而放宽。
  const [candidates, configured] = await Promise.all([
    prisma.aiProvider.findMany({
      where: {
        enabled: true,
        OR: [{ ownerType: 'GLOBAL' }, { ownerType: 'USER', userId }]
      },
      orderBy: { createdAt: 'asc' }
    }),
    prisma.systemConfig.findUnique({ where: { key: 'defaultProviderId' } })
  ]);
  const isGlobal = (p: AiProvider) => p.ownerType === 'GLOBAL';
  const configuredId = typeof configured?.value === 'string' ? configured.value : null;
  const picked =
    candidates.find((p) => p.ownerType === 'USER' && p.isDefault) ??
    (configuredId ? candidates.find((p) => p.id === configuredId && isGlobal(p)) : undefined) ??
    candidates.find((p) => isGlobal(p) && p.isDefault) ??
    candidates.find(isGlobal);

  if (!picked) {
    throw new ApiError(400, 'NO_MODEL', '管理员尚未配置可用的 AI 模型，请先在设置中添加自己的模型');
  }
  return picked;
}

export function capabilitiesOf(provider: AiProvider): Capability[] {
  return normalizeCapabilities(provider.capabilities);
}

/**
 * 从候选里挑第一条勾了这项能力的，挑不到返回 null。
 *
 * 只管能力，不管归属和启停——那两样属于 SQL 的 where（谁私有、谁能用、有没有停用），
 * 把顺序传进来就是挑法，和语音转写那条（`src/app/api/stt/route.ts:41`）同一个口径。
 */
export function pickCapableProvider<T extends { capabilities: unknown }>(
  rows: readonly T[],
  capability: Capability
): T | null {
  return rows.find((row) => normalizeCapabilities(row.capabilities).includes(capability)) ?? null;
}

export async function testProvider(provider: AiProvider): Promise<{ ok: boolean; detail: string }> {
  const key = decryptProviderKey(provider);
  let target;
  try {
    target = await resolveProviderTarget(provider.baseUrl);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'URL 不安全' };
  }

  const modelsUrl = joinApiPath(provider.baseUrl, '/models');
  let safe;
  try {
    safe = await safeFetch(target, modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeoutMs: 15_000
    });
    if (safe.response.ok) {
      const text = await safe.response.text();
      let detail = '连接成功（/models）';
      try {
        const data = JSON.parse(text) as { data?: unknown[] };
        if (Array.isArray(data.data)) detail = `连接成功，可用模型 ${data.data.length} 个`;
      } catch {
        /* non-JSON success */
      }
      await safe.close();
      return { ok: true, detail };
    }
    if (![404, 405, 400].includes(safe.response.status)) {
      const status = safe.response.status;
      await safe.response.body?.cancel();
      await safe.close();
      return { ok: false, detail: `模型服务返回 HTTP ${status}` };
    }
    await safe.response.body?.cancel();
    await safe.close();
  } catch (err) {
    if (safe) await safe.close().catch(() => undefined);
    if (err instanceof ApiError) return { ok: false, detail: err.message };
    return { ok: false, detail: '无法连接模型服务' };
  }

  // Fall back to a one-token chat request, which is a real (small) API call.
  try {
    const target2 = await resolveProviderTarget(provider.baseUrl);
    const chatUrl = joinApiPath(provider.baseUrl, '/chat/completions');
    const res = await safeFetch(target2, chatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        model: provider.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      timeoutMs: 20_000
    });
    const ok = res.response.ok;
    const status = res.response.status;
    await res.response.body?.cancel();
    await res.close();
    log.info('provider.test', { providerId: provider.id, ok, status });
    return ok
      ? { ok: true, detail: '连接成功（/chat/completions）' }
      : { ok: false, detail: `模型服务返回 HTTP ${status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof ApiError ? err.message : '模型服务测试失败' };
  }
}
