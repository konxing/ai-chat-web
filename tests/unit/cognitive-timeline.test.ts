import { describe, expect, it } from 'vitest';
import { deriveTimelineEvents, type TimelineSource } from '@/lib/cognitive/timeline';
import type { MemoryDto, MemoryRevisionAction } from '@/lib/cognitive/memories';

/**
 * 认知时间线的派生逻辑（任务书 Phase 4）。
 *
 * 这一片只做**派生**：把已经存在的记忆行和演化边读成按时间排列的事件，
 * 不做事件抽取（4.1）、不做自然语言时间解析（4.2 的解析部分）、不做变化检测（4.3）。
 * 所以这里最重要的一条红线是任务书 4.4 那句「时间线应从真实记忆和认知事件中生成，
 * 不允许生成虚构经历」——落到可断言的形式就是两条：
 * 一、事件的每一个字段都来自输入里的某一行，派生不新增事实；
 * 二、时间不许假装比记下来的更精确。
 */

function memory(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: 'm-1',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
    type: 'fact',
    context: 'general',
    origin: 'explicit',
    content: '我在做 family-ai-chat。',
    confirmedAt: '2026-11-01T10:00:00.000Z',
    precision: 'unknown',
    validFrom: null,
    validTo: null,
    version: 1,
    supersededAt: null,
    recordedAt: '2026-11-01T10:00:00.000Z',
    ...overrides
  };
}

function edge(memoryId: string, previousId: string | null, overrides: { action?: MemoryRevisionAction; createdAt?: string } = {}) {
  return {
    memoryId,
    previousId,
    action: overrides.action ?? ('superseded' as MemoryRevisionAction),
    createdAt: overrides.createdAt ?? '2026-11-02T10:00:00.000Z'
  };
}

function source(input: { memories?: MemoryDto[]; edges?: TimelineSource['edges'] } = {}): TimelineSource {
  return { memories: input.memories ?? [], edges: input.edges ?? [] };
}

describe('事件从记忆行派生，不新增事实', () => {
  it('一条没有时间信息的记忆按记录时间成事件', () => {
    const events = deriveTimelineEvents(source({ memories: [memory()] }));

    expect(events).toHaveLength(1);
    expect(events[0].memoryId).toBe('m-1');
    expect(events[0].content).toBe('我在做 family-ai-chat。');
    expect(events[0].timeSource).toBe('recorded');
    expect(events[0].occurredAt).toBe('2026-11-01T10:00:00.000Z');
  });

  it('确认状态、来源和原始出处逐字段带到事件上，界面才答得出「这条凭什么」', () => {
    const [event] = deriveTimelineEvents(
      source({
        memories: [memory({ origin: 'inferred', confirmedAt: null, chatId: 'chat-9', sourceMessageId: 'msg-9' })]
      })
    );

    expect(event.origin).toBe('inferred');
    expect(event.confirmedAt).toBeNull();
    expect(event.chatId).toBe('chat-9');
    expect(event.sourceMessageId).toBe('msg-9');
  });

  it('已撤回的记忆不进时间线', () => {
    const events = deriveTimelineEvents(
      source({ memories: [memory(), memory({ id: 'm-2', origin: 'retracted', confirmedAt: null })] })
    );

    expect(events.map((event) => event.memoryId)).toEqual(['m-1']);
  });
});

describe('时间解析（任务书 4.2）', () => {
  it('今天提到的「去年发生的事」排在去年，不排在记录时间', () => {
    const events = deriveTimelineEvents(
      source({
        memories: [
          memory({ id: 'm-old', content: '2025 年我离开了上一家公司。', precision: 'year', validFrom: '2025-01-01T00:00:00.000Z' }),
          memory({ id: 'm-now', content: '我现在在写家庭助手。' })
        ]
      })
    );

    expect(events.map((event) => event.memoryId)).toEqual(['m-old', 'm-now']);
    expect(events[0].timeSource).toBe('validity');
    expect(events[0].occurredAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('时间精度是未知时事件按记录时间走，绝不补出一个日期', () => {
    const [event] = deriveTimelineEvents(source({ memories: [memory({ precision: 'unknown', validFrom: null })] }));

    expect(event.precision).toBe('unknown');
    expect(event.timeSource).toBe('recorded');
    expect(event.validFrom).toBeNull();
  });

  it('同为「年」精度的两条打平时用记录时间定序，界面上不假装更精确', () => {
    const events = deriveTimelineEvents(
      source({
        memories: [
          memory({ id: 'm-b', precision: 'year', validFrom: '2025-01-01T00:00:00.000Z', recordedAt: '2026-11-02T09:00:00.000Z' }),
          memory({ id: 'm-a', precision: 'year', validFrom: '2025-01-01T00:00:00.000Z', recordedAt: '2026-11-01T09:00:00.000Z' })
        ]
      })
    );

    expect(events.map((event) => event.memoryId)).toEqual(['m-a', 'm-b']);
    expect(events.every((event) => event.precision === 'year')).toBe(true);
  });

  it('带结束区间的事件按起点排序，区间本身保留在事件里', () => {
    const events = deriveTimelineEvents(
      source({
        memories: [
          memory({ id: 'm-later', precision: 'month', validFrom: '2026-03-01T00:00:00.000Z', recordedAt: '2026-03-01T00:00:00.000Z' }),
          memory({
            id: 'm-range',
            precision: 'month',
            validFrom: '2025-06-01T00:00:00.000Z',
            validTo: '2026-01-01T00:00:00.000Z'
          })
        ]
      })
    );

    expect(events.map((event) => event.memoryId)).toEqual(['m-range', 'm-later']);
    expect(events[0].validTo).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('版本链折叠', () => {
  it('一条记忆的历史版本折叠成一条事件，不占三个坑', () => {
    const v3 = memory({ id: 'm-3', content: '项目已经换到 PostgreSQL。', version: 3 });
    const v2 = memory({ id: 'm-2', content: '项目在从 MySQL 迁走。', version: 2, supersededAt: '2026-11-02T10:00:00.000Z' });
    const v1 = memory({ id: 'm-1', content: '项目用 MySQL。', version: 1, supersededAt: '2026-11-01T10:00:00.000Z' });

    const events = deriveTimelineEvents(
      source({ memories: [v3, v2, v1], edges: [edge('m-3', 'm-2'), edge('m-2', 'm-1')] })
    );

    expect(events).toHaveLength(1);
    expect(events[0].memoryId).toBe('m-3');
    expect(events[0].content).toBe('项目已经换到 PostgreSQL。');
    expect(events[0].version).toBe(3);
    expect(events[0].historyCount).toBe(2);
  });

  it('折叠到的历史版数只数真实存在的行，不照抄版本号虚报', () => {
    // 边指向的两个旧行不在输入里（超出读取上限）：version 声称第 3 版，能折叠到的只有 0 条。
    const v3 = memory({ id: 'm-3', version: 3 });

    const [event] = deriveTimelineEvents(source({ memories: [v3], edges: [edge('m-3', 'm-2'), edge('m-2', 'm-1')] }));

    expect(event.memoryId).toBe('m-3');
    expect(event.version).toBe(3);
    expect(event.historyCount).toBe(0);
  });

  it('断链的旧行自己成为事件，不接到不认识的新版本上', () => {
    const v2 = memory({ id: 'm-2', version: 2, supersededAt: '2026-11-02T10:00:00.000Z' });
    const orphan = memory({ id: 'm-orphan', content: '一条没有后继的旧说法。', supersededAt: '2026-11-01T10:00:00.000Z' });

    const events = deriveTimelineEvents(source({ memories: [v2, orphan], edges: [edge('m-2', 'm-1')] }));

    expect(events.map((event) => event.memoryId).sort()).toEqual(['m-2', 'm-orphan']);
    expect(events.find((event) => event.memoryId === 'm-orphan')?.historyCount).toBe(0);
  });

  it('撤回的边不折叠任何东西：它没有 previousId，只说明这一版不再使用', () => {
    const kept = memory({ id: 'm-1' });

    const events = deriveTimelineEvents(source({ memories: [kept], edges: [edge('m-1', null, { action: 'retracted' })] }));

    expect(events).toHaveLength(1);
    expect(events[0].historyCount).toBe(0);
  });
});

describe('不虚构经历', () => {
  it('事件条数不超过输入行数，每个事件都指回输入里的一条记忆', () => {
    const rows = [
      memory({ id: 'm-1', recordedAt: '2026-11-01T10:00:00.000Z', supersededAt: '2026-11-02T10:00:00.000Z' }),
      memory({ id: 'm-2', recordedAt: '2026-11-02T10:00:00.000Z', type: 'goal', version: 2 }),
      memory({ id: 'm-3', recordedAt: '2026-11-03T10:00:00.000Z', type: 'preference' })
    ];

    const events = deriveTimelineEvents(source({ memories: rows, edges: [edge('m-2', 'm-1')] }));

    const ids = new Set(rows.map((row) => row.id));
    expect(events.length).toBeLessThanOrEqual(rows.length);
    for (const event of events) {
      expect(ids.has(event.memoryId)).toBe(true);
    }
    expect(new Set(events.map((event) => event.memoryId)).size).toBe(events.length);
    expect(events.map((event) => event.memoryId)).toEqual(['m-2', 'm-3']);
  });

  it('空输入得到空时间线：没有记忆就没有经历可排', () => {
    expect(deriveTimelineEvents(source())).toEqual([]);
  });
});
