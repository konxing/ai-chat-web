/**
 * 登录失败的 IP 锁定策略。纯逻辑，不碰数据库，便于单测。
 * 语义：同一 IP 在 5 分钟窗口内累计 3 次密码错误，该 IP 被锁 5 分钟。
 */

export const MAX_FAILED_ATTEMPTS = 3;
export const LOCK_WINDOW_MS = 5 * 60 * 1000;

export interface LockState {
  fails: number;
  firstFailAt: Date;
  lockedUntil: Date | null;
}

export interface LockVerdict {
  locked: boolean;
  retryAfterSec: number;
  attemptsLeft: number;
}

export function evaluateLock(state: LockState | null, now: number): LockVerdict {
  if (state?.lockedUntil && state.lockedUntil.getTime() > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((state.lockedUntil.getTime() - now) / 1000),
      attemptsLeft: 0
    };
  }
  const active = state && !windowExpired(state, now) ? state : null;
  if (!active) {
    return { locked: false, retryAfterSec: 0, attemptsLeft: MAX_FAILED_ATTEMPTS };
  }
  return {
    locked: false,
    retryAfterSec: 0,
    attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - active.fails)
  };
}

/**
 * 失败窗口是否已作废。锁定期一旦到期就重置计数，
 * 否则成员在解锁后只输错一次就会被再锁 5 分钟。
 */
function windowExpired(state: LockState, now: number): boolean {
  if (state.lockedUntil && state.lockedUntil.getTime() <= now) return true;
  return now - state.firstFailAt.getTime() > LOCK_WINDOW_MS;
}

export function nextLockState(state: LockState | null, now: number): LockState {
  const active = state && !windowExpired(state, now) ? state : null;
  const fails = active ? active.fails + 1 : 1;
  const firstFailAt = active ? active.firstFailAt : new Date(now);
  const lockedUntil = fails >= MAX_FAILED_ATTEMPTS ? new Date(now + LOCK_WINDOW_MS) : null;
  return { fails, firstFailAt, lockedUntil };
}
