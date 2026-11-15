import type { AiProvider } from '@prisma/client';
import { readBodyCapped } from './ai';
import { capabilitiesOf, decryptProviderKey } from './providers';
import { joinApiPath, resolveProviderTarget, safeFetch } from './ssrf';
import { readReasoningOptions, type ReasoningOptions } from './reasoning-levels';

const unavailable: ReasoningOptions = { levels: [], defaultLevel: null };
const cache = new Map<string, { expires: number; result: Promise<ReasoningOptions> }>();

export function getReasoningOptions(provider: AiProvider): Promise<ReasoningOptions> {
  if (!capabilitiesOf(provider).includes('text')) return Promise.resolve(unavailable);
  const key = `${provider.id}:${provider.updatedAt.toISOString()}`;
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expires > now) return existing.result;
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  const entry = { expires: now + 300_000, result: fetchOptions(provider).catch(() => {
    entry.expires = Date.now() + 30_000;
    return unavailable;
  }) };
  cache.set(key, entry);
  return entry.result;
}

async function fetchOptions(provider: AiProvider): Promise<ReasoningOptions> {
  const target = await resolveProviderTarget(provider.baseUrl);
  const { response, close } = await safeFetch(target, joinApiPath(provider.baseUrl, '/models'), {
    headers: { Authorization: `Bearer ${decryptProviderKey(provider)}`, Accept: 'application/json' },
    timeoutMs: 4000
  });
  try {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Model catalog unavailable');
    }
    const { text, truncated } = await readBodyCapped(response, 2_000_000);
    return truncated ? unavailable : readReasoningOptions(JSON.parse(text), provider.modelId);
  } finally {
    await close();
  }
}
