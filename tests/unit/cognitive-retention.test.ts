import { describe, expect, it } from 'vitest';
import { isMemoryUsable, retentionWindowDays } from '@/lib/cognitive/retention';
// 只取类型：policy.ts 顶部 import 了 prisma，运行时引入会把数据库驱动拖进这个纯测试。
import type { MemoryContext, MemoryPolicy, MemoryRetention } from '@/lib/cognitive/policy';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T12:00:00.000Z');

/** 策略表在测试里手写，不从 policy.ts 取默认值——那份默认值改了不该让这里的断言跟着变。 */
function policies(overrides: Partial<Record<MemoryContext, Partial<MemoryPolicy>>> = {}) {
  const base = (context: MemoryContext): MemoryPolicy => ({
    context,
    allowPersistence: true,
    allowedMemoryTypes: ['fact'],
    requireConfirmation: false,
    retention: 'forever',
    allowUserProfile: false,
    allowReflection: false,
    allowAssociation: false
  });
  const table = {} as Record<MemoryContext, MemoryPolicy>;
  for (const context of [
    'general',
    'technicalProject',
    'learning',
    'personalGoal',
    'personalReflection',
    'emotionalSupport',
    'decisionMaking'
  ] as MemoryContext[]) {
    table[context] = { ...base(context), ...overrides[context] };
  }
  return table;
}

function subject(
  context: MemoryContext,
  recordedAt: Date | string,
  chatId: string | null = 'chat-a'
) {
  return { context, chatId, recordedAt };
}

function daysAgo(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS - extraMs);
}

describe('retentionWindowDays', () => {
  it('把五种保留期翻译成天数，不限期的返回 null', () => {
    const expected: Record<MemoryRetention, number | null> = {
      forever: null,
      untilSuperseded: null,
      days90: 90,
      days30: 30,
      sessionOnly: 0
    };
    for (const [retention, days] of Object.entries(expected) as Array<[MemoryRetention, number | null]>) {
      expect(retentionWindowDays(retention)).toBe(days);
    }
  });
});

describe('isMemoryUsable', () => {
  it('forever 与 untilSuperseded 不受时间影响', () => {
    const scope = { policies: policies(), chatId: 'chat-b', now: NOW };
    expect(isMemoryUsable(subject('general', daysAgo(4000)), scope)).toBe(true);
    const table = policies({ general: { retention: 'untilSuperseded' } });
    expect(isMemoryUsable(subject('general', daysAgo(4000)), { ...scope, policies: table })).toBe(true);
  });

  it('days30 的边界含当天：29 天、整 30 天可用，30 天过一秒就不可用', () => {
    const scope = { policies: policies({ general: { retention: 'days30' } }), chatId: 'chat-b', now: NOW };
    expect(isMemoryUsable(subject('general', daysAgo(29)), scope)).toBe(true);
    expect(isMemoryUsable(subject('general', daysAgo(30)), scope)).toBe(true);
    expect(isMemoryUsable(subject('general', daysAgo(30, 1000)), scope)).toBe(false);
  });

  it('days90 同理', () => {
    const scope = { policies: policies({ general: { retention: 'days90' } }), chatId: 'chat-b', now: NOW };
    expect(isMemoryUsable(subject('general', daysAgo(89)), scope)).toBe(true);
    expect(isMemoryUsable(subject('general', daysAgo(91)), scope)).toBe(false);
  });

  it('sessionOnly 只在产生它的那次对话里可用', () => {
    const scope = { policies: policies({ emotionalSupport: { retention: 'sessionOnly' } }), chatId: 'chat-a', now: NOW };
    expect(isMemoryUsable(subject('emotionalSupport', daysAgo(0)), scope)).toBe(true);
    expect(isMemoryUsable(subject('emotionalSupport', daysAgo(0)), { ...scope, chatId: 'chat-b' })).toBe(false);
  });

  it('sessionOnly 且来源对话已丢失时不可用——无法证明它属于当前会话就不放进来', () => {
    const scope = { policies: policies({ general: { retention: 'sessionOnly' } }), chatId: 'chat-a', now: NOW };
    expect(isMemoryUsable(subject('general', daysAgo(0), null), scope)).toBe(false);
  });

  it('按记忆自己的情境取策略，不受别的情境影响', () => {
    const table = policies({ general: { retention: 'forever' }, emotionalSupport: { retention: 'days30' } });
    const scope = { policies: table, chatId: 'chat-b', now: NOW };
    expect(isMemoryUsable(subject('general', daysAgo(500)), scope)).toBe(true);
    expect(isMemoryUsable(subject('emotionalSupport', daysAgo(500)), scope)).toBe(false);
  });

  it('策略表里没有这个情境就当作不可用', () => {
    const table: Partial<Record<MemoryContext, MemoryPolicy>> = policies();
    delete table.general;
    const scope = {
      policies: table as Record<MemoryContext, MemoryPolicy>,
      chatId: 'chat-a',
      now: NOW
    };
    expect(isMemoryUsable(subject('general', daysAgo(0)), scope)).toBe(false);
  });

  it('recordedAt 传 Date 和传 ISO 字符串结果一致', () => {
    const scope = { policies: policies({ general: { retention: 'days30' } }), chatId: 'chat-b', now: NOW };
    const when = daysAgo(31);
    expect(isMemoryUsable(subject('general', when), scope)).toBe(false);
    expect(isMemoryUsable(subject('general', when.toISOString()), scope)).toBe(false);
  });

  it('recordedAt 晚于 now（时钟偏移）时按可用处理，不因负年龄误删', () => {
    const scope = { policies: policies({ general: { retention: 'days30' } }), chatId: 'chat-b', now: NOW };
    expect(isMemoryUsable(subject('general', new Date(NOW.getTime() + DAY_MS)), scope)).toBe(true);
  });
});
