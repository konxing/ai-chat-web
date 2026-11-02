import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 记忆的中文化标签与时间回显，从 memory-module / memories 里搬出来单独放一个纯模块。
 *
 * 搬的原因是硬的，不是洁癖：memory-module.ts 和 memories.ts 顶部都 import 了 prisma，
 * 设置页那个客户端组件只要拿几个标签，直接引用就会把整个数据库驱动拖进浏览器包。
 *
 * 这里对 memories / policy 只做类型导入：`import type` 编译期就被抹掉，不会把 prisma
 * 拉进测试进程，也就测得出「纯模块」这个性质。枚举值直接写在用例里，标签表必须逐个对上。
 */
import type { MemoryOrigin, MemoryRevisionAction, TimePrecision } from '@/lib/cognitive/memories';
import type { MemoryContext, MemoryRetention, MemoryType } from '@/lib/cognitive/policy';
import {
  CONTEXT_LABELS,
  CONTEXT_ORDER,
  ORIGIN_LABELS,
  RETENTION_LABELS,
  RETENTION_ORDER,
  REVISION_ACTION_LABELS,
  TYPE_LABELS,
  TYPE_ORDER,
  describePolicySummary,
  describeValidRange
} from '@/lib/cognitive/memory-display';

const TYPES: MemoryType[] = ['fact', 'preference', 'goal', 'project', 'decision', 'emotion'];
const CONTEXTS: MemoryContext[] = [
  'general',
  'technicalProject',
  'learning',
  'personalGoal',
  'personalReflection',
  'emotionalSupport',
  'decisionMaking'
];
const ORIGINS: MemoryOrigin[] = ['explicit', 'userConfirmed', 'observed', 'inferred', 'hypothesis', 'retracted'];
const ACTIONS: MemoryRevisionAction[] = ['superseded', 'retracted'];
const RETENTIONS: MemoryRetention[] = ['forever', 'untilSuperseded', 'days90', 'days30', 'sessionOnly'];

function range(precision: TimePrecision, validFrom: string | null, validTo: string | null = null) {
  return describeValidRange({ precision, validFrom, validTo });
}

describe('记忆标签', () => {
  it('六种记忆类型都有中文标签，界面不会渲染出 undefined', () => {
    expect(TYPES.map((type) => TYPE_LABELS[type])).toEqual(['事实', '偏好', '目标', '项目', '决策', '情绪']);
  });

  it('七个情境都有中文标签', () => {
    for (const context of CONTEXTS) expect(CONTEXT_LABELS[context]).toBeTruthy();
    expect(CONTEXT_LABELS.emotionalSupport).toBe('情绪支持');
    expect(CONTEXT_LABELS.general).toBe('日常');
  });

  it('六种来源都有中文标签，「推断」「假设」不许写成用户说过', () => {
    expect(ORIGINS.map((origin) => ORIGIN_LABELS[origin])).toEqual([
      '亲口说',
      '已确认',
      '观察到',
      '推断',
      '假设',
      '已撤回'
    ]);
  });

  it('演化边的两种动作都有中文标签', () => {
    expect(ACTIONS.map((action) => REVISION_ACTION_LABELS[action])).toEqual(['更新为新说法', '撤回']);
  });
});

describe('有效区间回显', () => {
  it('按精度显示，绝不显示比当初记录更精确的时间', () => {
    expect(range('year', '2026-01-01T00:00:00.000Z')).toBe('2026年');
    expect(range('month', '2026-03-01T00:00:00.000Z')).toBe('2026年3月');
    expect(range('day', '2026-03-05T00:00:00.000Z')).toBe('2026年3月5日');
    expect(range('timestamp', '2026-03-05T08:00:00.000Z')).toBe('2026年3月5日 08:00');
  });

  it('精度未知或没有起点时只显示「时间未知」', () => {
    expect(range('unknown', '2026-03-05T08:00:00.000Z')).toBe('时间未知');
    expect(range('day', null)).toBe('时间未知');
  });

  it('有终点时显示区间，两侧用同一个精度', () => {
    expect(range('month', '2026-03-01T00:00:00.000Z', '2026-05-20T00:00:00.000Z')).toBe('2026年3月～2026年5月');
    expect(range('day', '2026-03-05T00:00:00.000Z', '2026-03-06T00:00:00.000Z')).toBe('2026年3月5日～2026年3月6日');
  });
});

describe('保留期标签与渲染顺序', () => {
  it('五种保留期都有中文标签，界面不会渲染出 undefined', () => {
    expect(RETENTIONS.map((retention) => RETENTION_LABELS[retention])).toEqual([
      '长期保留',
      '直到有新说法',
      '90 天',
      '30 天',
      '只在当次对话'
    ]);
  });

  it('三份顺序表覆盖全部枚举值且不重复', () => {
    expect([...CONTEXT_ORDER].sort()).toEqual([...CONTEXTS].sort());
    expect([...TYPE_ORDER].sort()).toEqual([...TYPES].sort());
    expect([...RETENTION_ORDER].sort()).toEqual([...RETENTIONS].sort());
  });

  it('每个枚举值都有标签，顺序表里的键不会漏', () => {
    for (const context of CONTEXT_ORDER) expect(CONTEXT_LABELS[context]).toBeTruthy();
    for (const type of TYPE_ORDER) expect(TYPE_LABELS[type]).toBeTruthy();
    for (const retention of RETENTION_ORDER) expect(RETENTION_LABELS[retention]).toBeTruthy();
  });
});

describe('策略摘要', () => {
  const base = {
    allowPersistence: true,
    allowedMemoryTypes: ['fact', 'preference', 'goal'] as MemoryType[],
    requireConfirmation: false,
    retention: 'forever' as MemoryRetention
  };

  it('正常配置报出类型数量和保留期', () => {
    expect(describePolicySummary(base)).toBe('允许保存 · 记 3 种类型 · 长期保留');
    expect(describePolicySummary({ ...base, retention: 'days30' })).toBe('允许保存 · 记 3 种类型 · 30 天');
  });

  it('关掉持久化时只说「不保存」，不再并列其它设置', () => {
    expect(describePolicySummary({ ...base, allowPersistence: false, retention: 'days30' })).toBe('不保存');
  });

  it('要求先确认时说「先问再记」——这条比类型和保留期更紧', () => {
    expect(describePolicySummary({ ...base, requireConfirmation: true })).toBe('先问再记');
  });

  it('一个类型都不选时明说不记任何类型，而不是显示「记 0 种类型」', () => {
    expect(describePolicySummary({ ...base, allowedMemoryTypes: [] })).toBe('允许保存 · 不记任何类型');
  });
});

describe('纯模块边界', () => {
  it('除了类型导入，不引用任何服务端模块——客户端组件才能安全引用', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/lib/cognitive/memory-display.ts'), 'utf8');
    const runtimeImports = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('import') && !line.startsWith('import type'));
    expect(runtimeImports).toEqual([]);
  });
});
