import { beforeEach, describe, expect, it } from 'vitest';
import { rateLimit, resetRateLimitForTests } from '@/lib/rate-limit';
import {
  emailSchema,
  ipRuleInputSchema,
  passwordSchema,
  registerRequestSchema,
  sendMessageSchema,
  usernameSchema
} from '@/lib/validation';

describe('in-memory rate limiter', () => {
  beforeEach(() => resetRateLimitForTests());

  it('allows requests up to the limit and blocks the next one', () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimit('login:ip:1.2.3.4', 3, 60_000).ok).toBe(true);
    }
    const blocked = rateLimit('login:ip:1.2.3.4', 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('keys are isolated', () => {
    expect(rateLimit('a', 1, 60_000).ok).toBe(true);
    expect(rateLimit('b', 1, 60_000).ok).toBe(true);
    expect(rateLimit('a', 1, 60_000).ok).toBe(false);
  });

  it('reset clears all counters', () => {
    expect(rateLimit('x', 1, 60_000).ok).toBe(true);
    expect(rateLimit('x', 1, 60_000).ok).toBe(false);
    resetRateLimitForTests();
    expect(rateLimit('x', 1, 60_000).ok).toBe(true);
  });
});

/**
 * key 空间的体积上限。`login:ip:` 与 `forgot:ip:` 的 key 取自 `x-client-ip`
 * 头（`src/lib/http.ts:62`），只要有一个请求能绕过 nginx 直接打到 3000 端口，
 * 这个头就是客户端说了算——每个假 IP 都留下一个活到窗口结束的桶，而正常清扫
 * 有 60 秒的节流（`src/lib/rate-limit.ts:31`）。没有上限时这就是免费的内存放大。
 *
 * 淘汰只挑**最早到期**的桶：那些本来就在几十秒内会被正常清扫掉的计数，损失最小；
 * 而 `login:id:` / `forgot:email:` 这类 15 分钟窗口的账号级桶会最后被碰到。
 * 挡 IP 暴力这件事也不只靠这里的桶——同一份判断在 Postgres 的 `LoginLock` 表里
 * （`prisma/schema.prisma:325`），淘汰内存桶动不到它。
 *
 * 三条用例只能拿 `rateLimit()` 的返回值拼，不新增任何内省导出：
 * 「桶被淘汰」唯一的可观测形式就是它的计数消失。
 */
describe('限流桶的 key 数量上限', () => {
  beforeEach(() => resetRateLimitForTests());

  function flood(count: number, windowMs: number): void {
    for (let i = 0; i < count; i++) rateLimit(`flood:${i}`, 5, windowMs);
  }

  it('正向对照：60 秒窗口的桶在 key 没撑满时不会被碰到', () => {
    expect(rateLimit('chat:user-9', 1, 60_000).ok).toBe(true);
    expect(rateLimit('chat:user-9', 1, 60_000).ok).toBe(false);
    flood(3_000, 15 * 60_000);
    // 远在上限之下 ⇒ 一个桶都不该被淘汰，计数仍然把请求挡着
    expect(rateLimit('chat:user-9', 1, 60_000).ok).toBe(false);
  });

  it('key 撑满后最早到期的桶被淘汰，计数随之消失', () => {
    // 这个桶 60 秒后到期，比灌进来的 15 分钟窗口桶都早，所以它是第一个被淘汰的。
    expect(rateLimit('chat:user-9', 1, 60_000).ok).toBe(true);
    expect(rateLimit('chat:user-9', 1, 60_000).ok).toBe(false);
    flood(60_000, 15 * 60_000);
    // 桶被挤掉 ⇒ 计数归零 ⇒ 同一条 key 重新可用。这是上限的代价，也是它唯一的可观测形式。
    expect(rateLimit('chat:user-9', 1, 60_000).ok).toBe(true);
  });

  it('淘汰先牺牲短窗口，15 分钟的账号级桶活下来', () => {
    expect(rateLimit('login:id:konxing', 1, 15 * 60_000).ok).toBe(true);
    expect(rateLimit('login:id:konxing', 1, 15 * 60_000).ok).toBe(false);
    // 灌进来的全是 60 秒窗口——它们都比账号级桶先到期，所以该由它们去填淘汰名额。
    flood(60_000, 60_000);
    expect(rateLimit('login:id:konxing', 1, 15 * 60_000).ok).toBe(false);
  });
});

describe('request validation schemas', () => {
  it('accepts valid usernames and emails', () => {
    expect(usernameSchema.safeParse('mira_2026').success).toBe(true);
    expect(usernameSchema.safeParse('小明子').success).toBe(true);
    expect(emailSchema.safeParse('Mira@Example.COM').data).toBe('mira@example.com');
  });

  it('rejects unsafe or malformed usernames', () => {
    for (const name of ['ab', 'a'.repeat(33), 'bad name', 'x<script>', 'emoji😀']) {
      expect(usernameSchema.safeParse(name).success).toBe(false);
    }
    for (const email of ['nope', 'a@b', 'x@y.z\n', 'x@.com']) {
      expect(emailSchema.safeParse(email).success).toBe(false);
    }
  });

  it('enforces password length bounds in the transport schema', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(10)).success).toBe(true);
  });

  it('normalizes registration input', () => {
    const parsed = registerRequestSchema.parse({ username: ' Mira ', email: 'Mira@Example.com ' });
    expect(parsed.username).toBe('Mira');
    expect(parsed.email).toBe('mira@example.com');
  });

  it('defaults message fields and bounds attachment count', () => {
    expect(sendMessageSchema.parse({})).toEqual({ content: '', attachmentIds: [] });
    const ids = Array.from({ length: 16 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(sendMessageSchema.safeParse({ content: 'hi', attachmentIds: ids }).success).toBe(false);
  });

  it('validates IP rule input and strips unknown fields', () => {
    const parsed = ipRuleInputSchema.parse({ cidr: '10.0.0.0/8', label: 'LAN' });
    expect(parsed.enabled).toBe(true);
    expect(ipRuleInputSchema.safeParse({ cidr: '' }).success).toBe(false);
    const stripped = ipRuleInputSchema.parse({ cidr: '10.0.0.0/8', extra: true }) as Record<string, unknown>;
    expect(stripped.extra).toBeUndefined();
  });
});
