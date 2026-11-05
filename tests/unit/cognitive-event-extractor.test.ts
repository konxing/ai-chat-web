import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, UNEMITTED_EVENT_KINDS, annotateEventKinds } from '@/lib/cognitive/event-extractor';
import { detectChanges, type ChangeObservation } from '@/lib/cognitive/change-detector';
import { deriveTimelineEvents, type TimelineEdge, type TimelineEvent } from '@/lib/cognitive/timeline';
import type { MemoryDto } from '@/lib/cognitive/memories';

/**
 * 任务书 4.1 的 EventExtractor。
 *
 * 4.1 给的是 12 类事件词汇。这一层的形状是**给已有的事件起名**，不是再造一份事件：
 * 一行记忆（或一条版本链的头）已经是 `deriveTimelineEvents` 算出来的一个事件，
 * 这里只判它属于 12 类里的哪一类，一类到底——所以时间线上不会多出第二条流水账，
 * 也不会出现「时间线说这是一次改口、变化那一屏说这只是另一件经历」那种两个世界。
 *
 * 三条不许越过的线，逐条有用例守着：
 *
 * 一、**没有来源的一类也不生成**。`DECISION_MADE` 的出处在 Phase 5 的 `DecisionRecord`，
 *    那儿才有「待确认的候选连决策都还不算」那个确认状态；记忆行里的 `decision` 类型只是
 *    「系统记得你说过这句话」，拿它冒充一次决策事件就是替用户把话说重。
 *    `MILESTONE` 归 6.1（它的两个来源恰好就是这一层的 GOAL_COMPLETED 和 DECISION_MADE，
 *    在这里再发一份就是同一个事实的第三种说法）。`CHALLENGE` 在库里没有任何一列记过它。
 * 二、**完成只在链上算**。第一版目标里带一句「我完成了…」不是一次到达——
 *    和 4.3 的 `chainSignal` 同一个判据、同一张 `COMPLETION_MARKERS`。
 * 三、**兴趣那两个 kind 继承 4.3 的簇判断**，不在这里重做相似度：
 *    只读 `subject === 'INTEREST'` 的观察，别的主题一条也不影响分类。
 *
 * 测试：src/lib/cognitive/event-extractor.ts
 */

const COMPLETED_TEXT = '我终于考过了科目二';

interface EventSeed {
  id: string;
  type: TimelineEvent['category'];
  content: string;
  version?: number;
  supersededAt?: string | null;
  confirmedAt?: string | null;
  recordedAt?: string;
}

function event(seed: EventSeed): TimelineEvent {
  const recordedAt = seed.recordedAt ?? '2026-10-01T00:00:00.000Z';
  return {
    memoryId: seed.id,
    category: seed.type,
    content: seed.content,
    context: 'general',
    origin: 'explicit',
    confirmedAt: seed.confirmedAt ?? null,
    precision: 'unknown',
    occurredAt: recordedAt,
    timeSource: 'recorded',
    validFrom: null,
    validTo: null,
    version: seed.version ?? 1,
    historyCount: 0,
    chatId: 'chat-1',
    sourceMessageId: `msg-${seed.id}`,
    recordedAt
  };
}

function interest(change: 'EMERGED' | 'SHIFTED', after: string[], before: string[] = []): ChangeObservation {
  return {
    subject: 'INTEREST',
    change,
    topicTokens: ['跑步'],
    beforeMemoryIds: before,
    afterMemoryIds: after,
    sampleCount: after.length + before.length,
    observationSpanDays: 20,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    timePrecision: 'TIMESTAMP',
    confirmed: true
  };
}

function kindsOf(events: TimelineEvent[], observations: ChangeObservation[] = []): string[] {
  return annotateEventKinds({ events, observations }).map((item) => item.kind);
}

describe('任务书 4.1 的那 12 类词汇', () => {
  it('词汇逐字就是任务书列的 12 个，一个不多一个不少', () => {
    expect(EVENT_KINDS).toEqual([
      'EXPERIENCE',
      'GOAL_CREATED',
      'GOAL_CHANGED',
      'GOAL_COMPLETED',
      'INTEREST_EMERGED',
      'INTEREST_SHIFTED',
      'PREFERENCE_CHANGED',
      'PROJECT_STARTED',
      'PROJECT_UPDATED',
      'MILESTONE',
      'CHALLENGE',
      'DECISION_MADE'
    ]);
  });

  it('这一屏不生成的正好三类，且都在这 12 类里', () => {
    expect(UNEMITTED_EVENT_KINDS).toEqual(['DECISION_MADE', 'MILESTONE', 'CHALLENGE']);
    for (const kind of UNEMITTED_EVENT_KINDS) expect(EVENT_KINDS).toContain(kind);
    expect(EVENT_KINDS.length - UNEMITTED_EVENT_KINDS.length).toBe(9);
  });

  it('没有事件就是没有时间线，不凭空造一条', () => {
    expect(annotateEventKinds({ events: [], observations: [] })).toEqual([]);
  });
});

describe('目标那一类', () => {
  it('第一版目标是一次「定下目标」', () => {
    expect(kindsOf([event({ id: 'g1', type: 'goal', content: '我要考科目二' })])).toEqual(['GOAL_CREATED']);
  });

  it('改过一版的目标是一次「目标改了说法」', () => {
    expect(kindsOf([event({ id: 'g2', type: 'goal', content: '改成考科目三', version: 2 })])).toEqual(['GOAL_CHANGED']);
  });

  it('新版本里出现完成说法，就是一次「目标完成」', () => {
    expect(kindsOf([event({ id: 'g3', type: 'goal', content: COMPLETED_TEXT, version: 2 })])).toEqual([
      'GOAL_COMPLETED'
    ]);
  });

  it('第一版带完成说法不算到达：完成只在版本链上算', () => {
    expect(kindsOf([event({ id: 'g4', type: 'goal', content: COMPLETED_TEXT, version: 1 })])).toEqual(['GOAL_CREATED']);
  });

  it('折叠不到的旧版本行仍然算它那次的「定下目标」', () => {
    expect(
      kindsOf([event({ id: 'g5', type: 'goal', content: '我要考科目二', supersededAt: '2026-10-20T00:00:00.000Z' })])
    ).toEqual(['GOAL_CREATED']);
  });
});

describe('项目与偏好', () => {
  it('第一版项目是「新项目」，新版本是「项目更新」', () => {
    expect(
      kindsOf([
        event({ id: 'p1', type: 'project', content: '我在用 Prisma' }),
        event({ id: 'p2', type: 'project', content: '我换成了 Drizzle', version: 2 })
      ])
    ).toEqual(['PROJECT_STARTED', 'PROJECT_UPDATED']);
  });

  it('改过一版的偏好是「偏好改了说法」', () => {
    expect(kindsOf([event({ id: 'r1', type: 'preference', content: '我习惯早上写代码', version: 2 })])).toEqual([
      'PREFERENCE_CHANGED'
    ]);
  });

  it('第一版偏好不冒充一种变化：任务书没给这一类', () => {
    expect(kindsOf([event({ id: 'r2', type: 'preference', content: '我习惯晚上写代码' })])).toEqual(['EXPERIENCE']);
  });
});

describe('兴趣那一类继承 4.3 的簇判断', () => {
  it('出现在「新近反复提到」那批里的行是 INTEREST_EMERGED', () => {
    const row = event({ id: 'i1', type: 'preference', content: '我最近每晚都去跑步' });
    expect(kindsOf([row], [interest('EMERGED', ['i1'])])).toEqual(['INTEREST_EMERGED']);
  });

  it('出现在「兴趣转移」新那一侧的行是 INTEREST_SHIFTED', () => {
    const row = event({ id: 'i2', type: 'preference', content: '我最近每晚都去跑步' });
    expect(kindsOf([row], [interest('SHIFTED', ['i2'], ['i0'])])).toEqual(['INTEREST_SHIFTED']);
  });

  it('兴趣转移的另一侧不跟着变：旧那一簇有自己的事件', () => {
    const older = event({ id: 'i0', type: 'preference', content: '我以前常去游泳' });
    expect(kindsOf([older], [interest('SHIFTED', ['i2'], ['i0'])])).toEqual(['EXPERIENCE']);
  });

  it('更具体的事实赢：簇里的第一版目标仍然是「定下目标」', () => {
    const row = event({ id: 'i3', type: 'goal', content: '我要跑完一次半马' });
    expect(kindsOf([row], [interest('EMERGED', ['i3'])])).toEqual(['GOAL_CREATED']);
  });

  it('更具体的事实赢：簇里改过口的偏好仍然是「偏好改了说法」', () => {
    const row = event({ id: 'i4', type: 'preference', content: '我习惯早上跑步', version: 2 });
    expect(kindsOf([row], [interest('SHIFTED', ['i4'], ['i3'])])).toEqual(['PREFERENCE_CHANGED']);
  });

  /**
   * 这条只翻 `subject`，`change` 保持 EMERGED / SHIFTED 不动。
   * 探针记在这里：先前这一条把 change 也一起换成 RECURRING / STILL_OPEN，
   * 于是「把 subject 那道过滤删掉」的变异活了下来——它其实是被 `change` 挡住的红线，
   * 守的不是它自称守的那一样。
   */
  it('别的主题就算带着 EMERGED / SHIFTED 也不影响分类', () => {
    const row = event({ id: 'i5', type: 'preference', content: '我最近每晚都去跑步' });
    for (const subject of ['GOAL', 'PROJECT', 'PREFERENCE', 'REPETITION', 'UNRESOLVED'] as const) {
      const emerged: ChangeObservation = { ...interest('EMERGED', ['i5']), subject };
      const shifted: ChangeObservation = { ...interest('SHIFTED', ['i5'], ['i0']), subject };
      expect(kindsOf([row], [emerged, shifted])).toEqual(['EXPERIENCE']);
    }
  });

  it('INTEREST 主题里的 RECURRING 不冒充「新提起的事」', () => {
    const row = event({ id: 'i6', type: 'preference', content: '我最近每晚都去跑步' });
    const recurring: ChangeObservation = { ...interest('EMERGED', ['i6']), change: 'RECURRING' };
    const withdrawn: ChangeObservation = { ...interest('SHIFTED', ['i6'], ['i0']), change: 'WITHDRAWN' };
    expect(kindsOf([row], [recurring, withdrawn])).toEqual(['EXPERIENCE']);
  });
});

describe('剩下的一切都落进「一段经历」', () => {
  it('事实、情绪、决策类型的记忆行都只是一段经历', () => {
    expect(
      kindsOf([
        event({ id: 'x1', type: 'fact', content: '我在杭州' }),
        event({ id: 'x2', type: 'emotion', content: '我这阵子很累' }),
        event({ id: 'x3', type: 'decision', content: '我选了 Prisma' })
      ])
    ).toEqual(['EXPERIENCE', 'EXPERIENCE', 'EXPERIENCE']);
  });

  it('决策类型那一条不冒充 DECISION_MADE：这一层没有确认状态可依', () => {
    const row = event({ id: 'x4', type: 'decision', content: '我选了 Prisma', confirmedAt: '2026-10-02T00:00:00.000Z' });
    expect(kindsOf([row])).toEqual(['EXPERIENCE']);
  });

  it('造得出 9 类，三件没有来源的一条也不生成', () => {
    const events = [
      event({ id: 'a', type: 'goal', content: '我要考科目二' }),
      event({ id: 'b', type: 'goal', content: '改成考科目三', version: 2 }),
      event({ id: 'c', type: 'goal', content: COMPLETED_TEXT, version: 2 }),
      event({ id: 'd', type: 'project', content: '我在用 Prisma' }),
      event({ id: 'e', type: 'project', content: '我换成了 Drizzle', version: 2 }),
      event({ id: 'f', type: 'preference', content: '我习惯早上写代码', version: 2 }),
      event({ id: 'g', type: 'preference', content: '我最近每晚都去跑步' }),
      event({ id: 'h', type: 'preference', content: '我最近每天去爬山' }),
      event({ id: 'i', type: 'fact', content: '我在杭州' })
    ];
    const observations = [interest('EMERGED', ['g']), interest('SHIFTED', ['h'], ['g'])];
    const kinds = kindsOf(events, observations);
    expect(kinds).toEqual([
      'GOAL_CREATED',
      'GOAL_CHANGED',
      'GOAL_COMPLETED',
      'PROJECT_STARTED',
      'PROJECT_UPDATED',
      'PREFERENCE_CHANGED',
      'INTEREST_EMERGED',
      'INTEREST_SHIFTED',
      'EXPERIENCE'
    ]);
    for (const kind of kinds) expect(UNEMITTED_EVENT_KINDS).not.toContain(kind);
  });
});

describe('接得上：这一层不改时间线算出来的东西', () => {
  it('除 kind 以外逐字段等，顺序和条数都不动', () => {
    const events = [
      event({ id: 'a', type: 'fact', content: '我在杭州', recordedAt: '2026-09-01T00:00:00.000Z' }),
      event({ id: 'b', type: 'goal', content: '我要考科目二', recordedAt: '2026-10-01T00:00:00.000Z' })
    ];
    const annotated = annotateEventKinds({ events, observations: [] });
    expect(annotated.map(({ kind: _kind, ...rest }) => rest)).toEqual(events);
  });

  it('接在 deriveTimelineEvents 后面：每一条事件都拿得到一个类别', () => {
    interface RowSeed {
      id: string;
      type: MemoryDto['type'];
      content: string;
      version?: number;
      supersededAt?: string | null;
      recordedAt?: string;
    }
    const row = (seed: RowSeed): MemoryDto => ({
      id: seed.id,
      chatId: 'chat-1',
      sourceMessageId: `msg-${seed.id}`,
      type: seed.type,
      context: 'general',
      origin: 'explicit',
      content: seed.content,
      confirmedAt: null,
      precision: 'unknown',
      validFrom: null,
      validTo: null,
      version: seed.version ?? 1,
      supersededAt: seed.supersededAt ?? null,
      recordedAt: seed.recordedAt ?? '2026-10-01T00:00:00.000Z'
    });
    const edge = (memoryId: string, previousId: string | null): TimelineEdge => ({
      memoryId,
      previousId,
      action: 'superseded',
      createdAt: '2026-10-20T00:00:00.000Z'
    });

    const memories = [
      row({
        id: 'old',
        type: 'goal',
        content: '我要考科目二',
        supersededAt: '2026-10-20T00:00:00.000Z',
        recordedAt: '2026-09-01T00:00:00.000Z'
      }),
      row({ id: 'new', type: 'goal', content: COMPLETED_TEXT, version: 2, recordedAt: '2026-10-21T00:00:00.000Z' })
    ];
    const edges = [edge('new', 'old')];
    const events = deriveTimelineEvents({ memories, edges });
    const observations = detectChanges({ now: new Date('2026-11-05T00:00:00.000Z'), memories, edges }).observations;
    const annotated = annotateEventKinds({ events, observations });

    expect(annotated).toHaveLength(1);
    expect(annotated[0]!.memoryId).toBe('new');
    expect(annotated[0]!.kind).toBe('GOAL_COMPLETED');
  });
});
