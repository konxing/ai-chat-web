interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

/**
 * key 数量的硬上限。`login:ip:` 与 `forgot:ip:` 的 key 取自 `x-client-ip`
 * （`src/lib/http.ts` 的 getRequestIp），那个头是 nginx 写的——任何能绕过代理直接打到
 * 端口的请求都可以每个来回换一个假 IP，于是 map 的大小就由客户端说了算。
 * 50_000 个桶是 10MB 量级，够六千个活跃用户同时占满各自那七八条 key。
 */
const MAX_KEYS = 50_000;

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
  limit: number;
}

function dropExpired(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  dropExpired(now);
}

/**
 * 撑满时按 `resetAt` 从早到晚淘汰，不按插入顺序：快到期的那批本来就在几十秒内会被
 * sweep 清掉，先牺牲它们丢掉的计数最少，15 分钟的账号级桶最后才轮到。
 * 一次退到一半，全表排序因此摊薄成每 25_000 次插入才发生一次。
 */
function makeRoom(now: number) {
  if (buckets.size < MAX_KEYS) return;
  // 常态清扫有 60 秒的节流，撑满时等不了它，先把已经到期的桶要回来
  dropExpired(now);
  if (buckets.size < MAX_KEYS) return;
  const victims = [...buckets.keys()]
    .sort((a, b) => buckets.get(a)!.resetAt - buckets.get(b)!.resetAt)
    .slice(0, MAX_KEYS / 2);
  for (const key of victims) buckets.delete(key);
}

/** Process-local sliding fixed-window limiter. The app is designed for a single instance. */
export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  sweep(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    makeRoom(now);
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count++;
  const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return {
    ok: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSec,
    limit
  };
}

export function resetRateLimitForTests(): void {
  buckets.clear();
}
