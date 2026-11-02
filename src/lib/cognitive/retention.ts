import type { MemoryContext, MemoryPolicy, MemoryRetention } from './policy';

/**
 * 保留期的执行点。策略里的 retention 此前只被 write-decision 当作「情境信号打架时谁更保守」
 * 的一个权重，落到库里的行不会因此消失——选「30 天」和选「长期保留」在实际使用上没有任何区别，
 * 那就是个假控件。这里补上它真正的语义。
 *
 * 两条边界要先说清楚：
 * 一、只作用在对话读侧，不是删除。过了期限的记忆不再进入上下文，但行还在库里，
 *    用户仍能在「记忆」里看到并撤回。真正的永久删除是另一个动作（任务书 7.2 的 DELETE）。
 * 二、不管时间有效性。validFrom/validTo 是「这件事什么时候成立」，由 listMemories 的 asOf 过滤；
 *    retention 是「这条记录还留多久」，两者是不同的问题，不在这一个函数里混着判。
 *
 * 纯函数，不碰数据库：只允许 import type。
 * 测试：tests/unit/cognitive-retention.test.ts
 */

/** sessionOnly 用 0 表示「没有跨会话的窗口」，走的是对话归属判断而不是时间判断。 */
const WINDOW_DAYS: Record<MemoryRetention, number | null> = {
  forever: null,
  untilSuperseded: null,
  days90: 90,
  days30: 30,
  sessionOnly: 0
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionSubject {
  context: MemoryContext;
  chatId: string | null;
  recordedAt: Date | string;
}

export interface RetentionScope {
  policies: Record<MemoryContext, MemoryPolicy>;
  /** 当前这轮对话的 id：sessionOnly 的记忆只有在这里才可见。 */
  chatId: string;
  now: Date;
}

export function retentionWindowDays(retention: MemoryRetention): number | null {
  return WINDOW_DAYS[retention];
}

export function isMemoryUsable(subject: RetentionSubject, scope: RetentionScope): boolean {
  // 策略表里没有这个情境＝配置异常，按不可用处理：这是隐私控件，宁可少用一条记忆。
  const policy = scope.policies[subject.context];
  if (!policy) return false;

  const retention = policy.retention;
  if (retention === 'sessionOnly') {
    // 来源对话已经没了（chatId 为 null）就没法证明它属于当前会话，一律不放进来。
    return subject.chatId !== null && subject.chatId === scope.chatId;
  }

  const days = retentionWindowDays(retention);
  if (days === null) return true;

  const recordedAt = typeof subject.recordedAt === 'string' ? new Date(subject.recordedAt) : subject.recordedAt;
  const age = scope.now.getTime() - recordedAt.getTime();
  // 时钟偏移导致的负年龄按可用处理：那不是「过期」，误删一条真记忆比多留一条贵的多。
  return age <= days * DAY_MS;
}
