import { describe, expect, it } from 'vitest';
import {
  evaluateLock,
  nextLockState,
  MAX_FAILED_ATTEMPTS,
  LOCK_WINDOW_MS,
  type LockState
} from '@/lib/login-lock';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

function state(overrides: Partial<LockState> = {}): LockState {
  return {
    fails: 0,
    firstFailAt: new Date(NOW),
    lockedUntil: null,
    ...overrides
  };
}

describe('登录失败锁定策略', () => {
  it('默认阈值为 3 次失败、锁定 5 分钟', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(3);
    expect(LOCK_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('无记录与窗口外的记录都给满 3 次尝试', () => {
    expect(evaluateLock(null, NOW)).toMatchObject({ locked: false, attemptsLeft: 3 });
    const stale = state({ fails: 3, firstFailAt: new Date(NOW - LOCK_WINDOW_MS - 1) });
    expect(evaluateLock(stale, NOW)).toMatchObject({ locked: false, attemptsLeft: 3 });
  });

  it('窗口内每次失败扣掉一次尝试机会', () => {
    const one = state({ fails: 1 });
    const two = state({ fails: 2 });
    expect(evaluateLock(one, NOW).attemptsLeft).toBe(2);
    expect(evaluateLock(two, NOW).attemptsLeft).toBe(1);
  });

  it('第三次失败即锁定该 IP 五分钟', () => {
    const next = nextLockState(state({ fails: 2 }), NOW);
    expect(next.fails).toBe(3);
    expect(next.lockedUntil?.getTime()).toBe(NOW + LOCK_WINDOW_MS);
    expect(evaluateLock(next, NOW)).toMatchObject({ locked: true, attemptsLeft: 0 });
  });

  it('锁定期间返回剩余秒数', () => {
    const locked = state({ fails: 3, lockedUntil: new Date(NOW + 90_000) });
    expect(evaluateLock(locked, NOW).retryAfterSec).toBe(90);
  });

  it('锁定到期后自动放行', () => {
    const expired = state({ fails: 3, firstFailAt: new Date(NOW - LOCK_WINDOW_MS), lockedUntil: new Date(NOW - 1) });
    expect(evaluateLock(expired, NOW)).toMatchObject({ locked: false, attemptsLeft: 3 });
  });

  it('解锁后只输错一次不会再被锁', () => {
    const justExpired = state({ fails: 3, firstFailAt: new Date(NOW - LOCK_WINDOW_MS), lockedUntil: new Date(NOW - 1000) });
    const next = nextLockState(justExpired, NOW);
    expect(next.fails).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });

  it('失败窗口过期后计数重新从一次开始', () => {
    const old = state({ fails: 2, firstFailAt: new Date(NOW - LOCK_WINDOW_MS - 1000) });
    const next = nextLockState(old, NOW);
    expect(next.fails).toBe(1);
    expect(next.firstFailAt.getTime()).toBe(NOW);
    expect(next.lockedUntil).toBeNull();
  });

  it('未满三次不锁定', () => {
    const next = nextLockState(state({ fails: 0 }), NOW);
    expect(next.lockedUntil).toBeNull();
    expect(next.fails).toBe(1);
  });

  it('锁定未到期时再次失败会续锁而不是放行', () => {
    const locked = state({ fails: 3, lockedUntil: new Date(NOW + 60_000) });
    const next = nextLockState(locked, NOW);
    expect(next.lockedUntil?.getTime()).toBe(NOW + LOCK_WINDOW_MS);
    expect(evaluateLock(next, NOW).locked).toBe(true);
  });
});
