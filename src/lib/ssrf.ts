import dns from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse
} from 'undici';
import { loadEnv } from './env';
import { isPrivateOrReservedIp, normalizeIp } from './ip';
import { ApiError } from './http';

export interface ResolvedTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
  allowPrivate: boolean;
}

function reject(message = '该地址不允许访问'): never {
  throw new ApiError(400, 'UNSAFE_URL', message);
}

async function validateProviderTarget(raw: string): Promise<ResolvedTarget> {
  const env = loadEnv();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject('URL 格式无效');
  }
  if (url.username || url.password) reject('URL 不能包含用户名或密码');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') reject('仅支持 http/https 地址');
  if (url.protocol === 'http:' && !env.ALLOW_PRIVATE_AI_URLS) {
    reject('生产环境中的模型地址必须使用 HTTPS');
  }
  if (url.hash) reject('URL 不能包含片段');
  if (url.href.length > 512) reject('URL 过长');

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses: Array<{ address: string; family: 4 | 6 }> = [];

  if (isIP(hostname)) {
    const parsed = normalizeIp(hostname);
    addresses.push({ address: parsed.ip, family: parsed.family === 'ipv4' ? 4 : 6 });
  } else {
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      if (!env.ALLOW_PRIVATE_AI_URLS) reject('模型地址不能指向本机或私有网络');
      addresses.push({ address: '127.0.0.1', family: 4 });
    } else {
      let records: Array<{ address: string; family: number }>;
      try {
        records = await dns.lookup(hostname, { all: true, verbatim: true });
      } catch {
        throw new ApiError(400, 'DNS_FAILED', '无法解析模型服务域名');
      }
      if (!records.length) throw new ApiError(400, 'DNS_FAILED', '模型服务域名没有可用地址');
      for (const record of records) {
        const family = record.family === 6 ? 6 : 4;
        addresses.push({ address: record.address, family });
      }
    }
  }

  if (!addresses.length) throw new ApiError(400, 'DNS_FAILED', '模型服务没有可用地址');

  if (!env.ALLOW_PRIVATE_AI_URLS) {
    for (const item of addresses) {
      if (isPrivateOrReservedIp(item.address)) {
        reject('模型地址解析到私有、环回或保留地址，已被阻止');
      }
    }
  }

  return { url, addresses, allowPrivate: env.ALLOW_PRIVATE_AI_URLS };
}

const TARGET_TTL_MS = 60_000;
const MAX_CACHED_TARGETS = 32;
const AGENT_OPTIONS = {
  connections: 8,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 10_000 }
};

const targetCache = new Map<string, { target: ResolvedTarget; expiresAt: number }>();
const dispatchers = new WeakMap<ResolvedTarget, Dispatcher>();

/**
 * 校验结果按 Base URL 缓存 60 秒，连接池跟着校验结果走。
 * 省掉的是每条消息一次的 DNS 查询和一次 TCP+TLS 握手；被固定的仍然是校验过的那批地址，
 * 所以防 DNS rebinding 的语义没有变，只是把"重新解析"换成了"到期再解析"。
 */
export async function resolveProviderTarget(raw: string): Promise<ResolvedTarget> {
  const hit = targetCache.get(raw);
  if (hit && hit.expiresAt > Date.now()) return hit.target;
  const target = await validateProviderTarget(raw);
  if (targetCache.size >= MAX_CACHED_TARGETS) {
    const oldest = targetCache.keys().next().value;
    if (oldest !== undefined) targetCache.delete(oldest);
  }
  targetCache.set(raw, { target, expiresAt: Date.now() + TARGET_TTL_MS });
  return target;
}

function dispatcherFor(target: ResolvedTarget): Dispatcher {
  const cached = dispatchers.get(target);
  if (cached) return cached;
  const dispatcher = target.allowPrivate
    ? new Agent(AGENT_OPTIONS)
    : new Agent({
        ...AGENT_OPTIONS,
        connect: {
          timeout: 10_000,
          // Pin the validated address so DNS rebinding cannot redirect the request.
          lookup: pinnedLookup(target)
        }
      });
  dispatchers.set(target, dispatcher);
  return dispatcher;
}

function pinnedLookup(target: ResolvedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    const requested = options.family;
    const family = requested === 6 || requested === 'IPv6' ? 6 : requested === 4 || requested === 'IPv4' ? 4 : undefined;
    const candidates = family ? target.addresses.filter((a) => a.family === family) : target.addresses;
    const chosen = candidates[0] || target.addresses[0];
    if (!chosen) {
      callback(new Error('No validated address'), '', 0);
      return;
    }
    if (options.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
    else callback(null, chosen.address, chosen.family);
  };
}

export interface SafeResponse {
  response: UndiciResponse;
  close: () => Promise<void>;
}

/** Fetch with SSRF protection, pinned DNS and no automatic redirects. */
export async function safeFetch(
  target: ResolvedTarget,
  pathOrUrl: string,
  init: UndiciRequestInit & { timeoutMs?: number } = {}
): Promise<SafeResponse> {
  const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, target.url);
  const dispatcher = dispatcherFor(target);
  const timeoutMs = init.timeoutMs ?? 60_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await undiciFetch(url, {
      ...init,
      redirect: 'manual',
      dispatcher,
      signal,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'User-Agent': 'FamilyAIChat/1.0'
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new ApiError(400, 'REDIRECT_BLOCKED', '模型服务返回了重定向，出于安全考虑已阻止');
    }
    return {
      response,
      // 连接池按 Base URL 共享，单次请求结束不关闭它，交给 keep-alive 复用。
      close: async () => {
        /* no-op */
      }
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
      throw new ApiError(504, 'AI_TIMEOUT', '模型服务请求超时');
    }
    throw new ApiError(502, 'AI_UNREACHABLE', '无法连接模型服务，请检查 Base URL 与网络');
  }
}

export function joinApiPath(baseUrl: string, path: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  if (clean.endsWith(path)) return clean;
  return `${clean}${path.startsWith('/') ? '' : '/'}${path}`;
}
