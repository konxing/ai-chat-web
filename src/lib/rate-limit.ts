interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
  limit: number;
}

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Process-local sliding fixed-window limiter. The app is designed for a single instance. */
export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  sweep(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
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
