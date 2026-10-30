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
    const ids = Array.from({ length: 13 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
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
