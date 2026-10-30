import { randomUUID } from 'node:crypto';
import type { AiProvider, ProviderOwner } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma';
import { decryptString, encryptString } from './crypto';
import { ApiError } from './http';
import { resolveProviderTarget, safeFetch, joinApiPath } from './ssrf';
import { log } from './logger';

export const CAPABILITIES = ['text', 'vision', 'files', 'audio'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().min(1).max(512),
  apiKey: z.string().trim().min(1).max(500).optional(),
  modelId: z.string().trim().min(1).max(128),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(4),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(64000).optional()
    })
    .strict()
    .optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false)
});

export type ProviderInput = z.infer<typeof providerInputSchema>;

export interface PublicProvider {
  id: string;
  ownerType: ProviderOwner;
  name: string;
  baseUrl: string;
  modelId: string;
  capabilities: Capability[];
  params: { temperature?: number; maxTokens?: number } | null;
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

function normalizeParams(value: unknown): { temperature?: number; maxTokens?: number } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const out: { temperature?: number; maxTokens?: number } = {};
  if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) {
    out.temperature = raw.temperature;
  }
  if (typeof raw.maxTokens === 'number' && raw.maxTokens >= 1 && raw.maxTokens <= 64000) {
    out.maxTokens = Math.floor(raw.maxTokens);
  }
  return Object.keys(out).length ? out : null;
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
  const userDefault = await prisma.aiProvider.findFirst({
    where: { ownerType: 'USER', userId, enabled: true, isDefault: true },
    orderBy: { createdAt: 'asc' }
  });
  if (userDefault) return userDefault;

  const settings = await prisma.systemConfig.findUnique({ where: { key: 'defaultProviderId' } });
  const configuredId = typeof settings?.value === 'string' ? settings.value : null;
  if (configuredId) {
    const configured = await prisma.aiProvider.findFirst({
      where: { id: configuredId, ownerType: 'GLOBAL', enabled: true }
    });
    if (configured) return configured;
  }

  const globalDefault = await prisma.aiProvider.findFirst({
    where: { ownerType: 'GLOBAL', enabled: true, isDefault: true },
    orderBy: { createdAt: 'asc' }
  });
  if (globalDefault) return globalDefault;

  const anyGlobal = await prisma.aiProvider.findFirst({
    where: { ownerType: 'GLOBAL', enabled: true },
    orderBy: { createdAt: 'asc' }
  });
  if (anyGlobal) return anyGlobal;

  throw new ApiError(400, 'NO_MODEL', '管理员尚未配置可用的 AI 模型，请先在设置中添加自己的模型');
}

export function capabilitiesOf(provider: AiProvider): Capability[] {
  return normalizeCapabilities(provider.capabilities);
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
