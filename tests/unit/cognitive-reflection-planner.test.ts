import { describe, expect, it } from 'vitest';
import type {
  ReflectableDecision,
  ReflectableMemory,
  ReflectableRevision
} from '@/lib/cognitive/reflection-planner';
import {
  INTEREST_SHIFT_MEDIAN_GAP_DAYS,
  INTEREST_SHIFT_MIN_SAMPLES,
  PATTERN_MIN_CHATS,
  PATTERN_MIN_SAMPLES,
  PATTERN_MIN_SPAN_DAYS,
  TOPIC_MIN_OVERLAP,
  UNRESOLVED_MIN_AGE_DAYS,
  planReflections
} from '@/lib/cognitive/reflection-planner';

/**
 * 反思规划层（任务书 6.2 的 ReflectionPlanner + 6.3 的多假设 + 6.6 的「不许编」）。
 *
 * 这一层只回答「有没有一件值得说的事」，不写任何中文——措辞全在 6-C，
 * 否则「同一条洞察的正文」会有两个出处，谁改了另一边都不会报错。
 *
 * 时间一律从外面传进来（now）：这些规则里全是「隔了多少天」，
 * 用系统时钟的测试过几天就会自己变红，那种红灯谁都读不出原因。
 */

const BASE = new Date('2026-01-01T00:00:00.000Z');
const day = (offset: number): Date => new Date(BASE.getTime() + offset * 86_400_000);
const NOW = day(200);

interface Seed {
  id: string;
  text: string;
  type?: ReflectableMemory['type'];
  origin?: ReflectableMemory['origin'];
  chatId?: string | null;
  recordedAt?: Date;
  validFrom?: Date | null;
  validPrecision?: ReflectableMemory['validPrecision'];
  supersededAt?: Date | null;
}

function memory(seed: Seed): ReflectableMemory {
  return {
    id: seed.id,
    text: seed.text,
    type: seed.type ?? 'FACT',
    origin: seed.origin ?? 'EXPLICIT',
    chatId: seed.chatId ?? null,
    recordedAt: seed.recordedAt ?? day(0),
    validFrom: seed.validFrom ?? null,
    validPrecision: seed.validPrecision ?? 'UNKNOWN',
    supersededAt: seed.supersededAt ?? null
  };
}

const find = <T extends { type: string }>(list: readonly T[], type: string): T | undefined =>
  list.find((entry) => entry.type === type);

describe('主题成簇', () => {
  it('阈值是命名常量：主题重合至少要两个词，而不是散在规则里的魔术数', () => {
    expect(TOPIC_MIN_OVERLAP).toBe(2);
  });

  it('两个词的池子不叫模式：样本数没到线上一条都不出，但记下「证据不足」', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1' }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2' })
      ]
    });
    expect(find(plan.findings, 'PATTERN')).toBeUndefined();
    const short = find(plan.insufficient, 'PATTERN');
    expect(short).toBeDefined();
    expect(short!.sampleCount).toBe(2);
    expect(short!.reason).toBe('BELOW_SAMPLE_MIN');
  });

  it('三条不同会话、跨 20 天的同主题记忆：出 PATTERN，样本数与跨度都带着', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(10) }),
        memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(20) })
      ]
    });
    const pattern = find(plan.findings, 'PATTERN')!;
    expect(pattern.supportMemoryIds).toEqual(['m1', 'm2', 'm3']);
    expect(pattern.sampleCount).toBe(3);
    expect(pattern.observationSpanDays).toBe(20);
    expect(plan.insufficient).toHaveLength(0);
  });

  it('同一个会话里重复三遍不算跨会话模式——会话数也是门槛之一', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(10) }),
        memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(20) })
      ]
    });
    expect(find(plan.findings, 'PATTERN')).toBeUndefined();
    expect(find(plan.insufficient, 'PATTERN')!.reason).toBe('BELOW_CHAT_MIN');
  });

  it('三条挤在同一天不算模式：跨度没到线就说证据不足', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(1) }),
        memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(2) })
      ]
    });
    expect(find(plan.findings, 'PATTERN')).toBeUndefined();
    expect(find(plan.insufficient, 'PATTERN')!.reason).toBe('BELOW_SPAN_MIN');
  });

  it('措辞漂移的同主题靠传递相连，仍然是一个簇：三条各自只与中间那条重合', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(10) }),
        memory({ id: 'm3', text: '数据库的迁移我记在笔记里', chatId: 'c3', recordedAt: day(20) })
      ]
    });
    expect(find(plan.findings, 'PATTERN')!.sampleCount).toBe(3);
  });
});

describe('被推翻的反例：池子里已经看见的反对证据要交出去', () => {
  it('同主题里有一条已被取代，它进 counterMemoryIds 而不是样本数', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(10) }),
        memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(20) }),
        memory({
          id: 'm4',
          text: '我的迁移笔记在数据库里',
          chatId: 'c4',
          recordedAt: day(21),
          supersededAt: day(30)
        })
      ]
    });
    const pattern = find(plan.findings, 'PATTERN')!;
    expect(pattern.sampleCount).toBe(3);
    expect(pattern.counterMemoryIds).toEqual(['m4']);
  });

  it('用户撤回过的记忆同样是反例，不算进样本', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(10) }),
        memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(20) }),
        memory({
          id: 'm4',
          text: '我的迁移笔记在数据库里',
          chatId: 'c4',
          recordedAt: day(21),
          origin: 'RETRACTED'
        })
      ]
    });
    expect(find(plan.findings, 'PATTERN')!.counterMemoryIds).toEqual(['m4']);
  });
});

describe('多假设（6.3）：规则分不开的时候一条都不许选', () => {
  it('PATTERN 必须带出三种解释，而不是替用户断定「你在形成长期兴趣」', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(10) }),
        memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(20) })
      ]
    });
    expect(find(plan.findings, 'PATTERN')!.hypothesisKeys).toEqual([
      'LONG_TERM_INTEREST',
      'STAGED_PROJECT',
      'TEMPORARY_LEARNING'
    ]);
  });

  it('数据本身就说了「不做了」的 CONTRADICTION 不给三种解释——那是把已知结论重新猜一遍', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我家住在杭州', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我家不在杭州', chatId: 'c2', recordedAt: day(40) })
      ]
    });
    expect(find(plan.findings, 'CONTRADICTION')!.hypothesisKeys).toEqual([]);
  });
});

describe('CONTRADICTION：两句都还有效、又互相打脸', () => {
  it('一句肯定一句否定、都未被取代 ⇒ 出洞察，两句都是证据', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我家住在杭州', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我家不在杭州', chatId: 'c2', recordedAt: day(40) })
      ]
    });
    const contradiction = find(plan.findings, 'CONTRADICTION')!;
    expect(contradiction.supportMemoryIds).toEqual(['m1', 'm2']);
    expect(contradiction.sampleCount).toBe(2);
    expect(contradiction.observationSpanDays).toBe(40);
  });

  it('改口已经走演化（旧的被取代）就不算未决矛盾：那条路有自己的记录', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我家住在杭州', chatId: 'c1', recordedAt: day(0), supersededAt: day(40) }),
        memory({ id: 'm2', text: '我家不在杭州', chatId: 'c2', recordedAt: day(40) })
      ]
    });
    expect(find(plan.findings, 'CONTRADICTION')).toBeUndefined();
  });

  it('两句都是肯定不算矛盾：没有否定标记就不要断言「打脸」', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我家住在杭州', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'm2', text: '我的家在杭州西湖', chatId: 'c2', recordedAt: day(40) })
      ]
    });
    expect(find(plan.findings, 'CONTRADICTION')).toBeUndefined();
  });
});

describe('UNRESOLVED：提了六十天没下文的目标', () => {
  it('目标满六十天且这一主题六十天内没有新消息 ⇒ 出洞察，时间取事实的有效时间', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({
          id: 'g1',
          text: '我打算今年把身体练回来',
          type: 'GOAL',
          chatId: 'c1',
          recordedAt: day(100),
          validFrom: day(95),
          validPrecision: 'MONTH'
        })
      ]
    });
    const unresolved = find(plan.findings, 'UNRESOLVED')!;
    expect(unresolved.supportMemoryIds).toEqual(['g1']);
    expect(unresolved.timeFrom).toEqual(day(95));
    expect(unresolved.timeTo).toEqual(NOW);
    expect(unresolved.timePrecision).toBe('MONTH');
    expect(unresolved.observationSpanDays).toBe(105);
  });

  it('同主题最近又有动静就不算「没下文」', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(10) }),
        memory({ id: 'm2', text: '我今年把身体练回来的事已经去跑步了', chatId: 'c2', recordedAt: day(195) })
      ]
    });
    expect(find(plan.findings, 'UNRESOLVED')).toBeUndefined();
  });

  it('目标才三天就说「证据不足」，不假装它是未解决', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(197) })
      ]
    });
    expect(find(plan.findings, 'UNRESOLVED')).toBeUndefined();
    expect(find(plan.insufficient, 'UNRESOLVED')!.reason).toBe('BELOW_AGE_MIN');
    expect(UNRESOLVED_MIN_AGE_DAYS).toBe(60);
  });

  it('非目标类型的旧记忆不产生 UNRESOLVED：任务书说的是「长期未解决的事项」', () => {
    const plan = planReflections({
      now: NOW,
      memories: [memory({ id: 'f1', text: '我的工号是 0042', type: 'FACT', chatId: 'c1', recordedAt: day(0) })]
    });
    expect(find(plan.findings, 'UNRESOLVED')).toBeUndefined();
    expect(plan.insufficient).toHaveLength(0);
  });
});

describe('GOAL_DRIFT：目标改了方向，两句都留着', () => {
  it('目标被新目标取代 ⇒ 出洞察，旧目标作为被取代的一方交出去', () => {
    const revisions: ReflectableRevision[] = [
      { action: 'SUPERSEDED', memoryId: 'g2', previousId: 'g1', createdAt: day(60) }
    ];
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(0), supersededAt: day(60) }),
        memory({ id: 'g2', text: '我打算今年把身体练回来然后再考虑比赛', type: 'GOAL', chatId: 'c2', recordedAt: day(60) })
      ],
      revisions
    });
    const drift = find(plan.findings, 'GOAL_DRIFT')!;
    expect(drift.supportMemoryIds).toEqual(['g2']);
    expect(drift.counterMemoryIds).toEqual(['g1']);
    expect(drift.sampleCount).toBe(2);
  });

  it('取代一个事实不是目标转向：只有两边都是目标才叫 DRIFT', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'f1', text: '我家住在杭州', chatId: 'c1', recordedAt: day(0), supersededAt: day(60) }),
        memory({ id: 'f2', text: '我家住在杭州西湖区', chatId: 'c2', recordedAt: day(60) })
      ],
      revisions: [{ action: 'SUPERSEDED', memoryId: 'f2', previousId: 'f1', createdAt: day(60) }]
    });
    expect(find(plan.findings, 'GOAL_DRIFT')).toBeUndefined();
  });

  it('撤回不是转向：RETRACTED 的边不产生 GOAL_DRIFT', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'g2', text: '我打算今年把身体练回来然后再考虑比赛', type: 'GOAL', chatId: 'c2', recordedAt: day(60) })
      ],
      revisions: [{ action: 'RETRACTED', memoryId: 'g2', previousId: 'g1', createdAt: day(60) }]
    });
    expect(find(plan.findings, 'GOAL_DRIFT')).toBeUndefined();
  });
});

describe('MILESTONE：一个里程碑必须有一个完成的样子', () => {
  it('目标被一句带完成说法的话取代 ⇒ 里程碑', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(0), supersededAt: day(60) }),
        memory({ id: 'g2', text: '我打算今年把身体练回来的事完成了', type: 'GOAL', chatId: 'c2', recordedAt: day(60) })
      ],
      revisions: [{ action: 'SUPERSEDED', memoryId: 'g2', previousId: 'g1', createdAt: day(60) }]
    });
    const milestone = find(plan.findings, 'MILESTONE')!;
    expect(milestone.supportMemoryIds).toEqual(['g1', 'g2']);
  });

  it('新说法里没有完成的意思就不是里程碑：不许把改道说成到达', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(0), supersededAt: day(60) }),
        memory({ id: 'g2', text: '我打算今年把身体练回来改成游泳', type: 'GOAL', chatId: 'c2', recordedAt: day(60) })
      ],
      revisions: [{ action: 'SUPERSEDED', memoryId: 'g2', previousId: 'g1', createdAt: day(60) }]
    });
    expect(find(plan.findings, 'MILESTONE')).toBeUndefined();
  });

  it('决策被用户确认了算一个里程碑，证据是那条决策行', () => {
    const decisions: ReflectableDecision[] = [
      {
        id: 'd1',
        status: 'CONFIRMED',
        topic: '我决定买这块显卡',
        decidedAt: day(50),
        confirmedAt: day(52),
        outcomeRecordedAt: null
      }
    ];
    const plan = planReflections({ now: NOW, memories: [], decisions });
    const milestone = find(plan.findings, 'MILESTONE')!;
    expect(milestone.supportDecisionIds).toEqual(['d1']);
    expect(milestone.supportMemoryIds).toEqual([]);
    expect(milestone.timePrecision).toBe('TIMESTAMP');
  });

  it('待确认的决策不是里程碑：门槛 8 说没确认的连决策都还不算', () => {
    const plan = planReflections({
      now: NOW,
      memories: [],
      decisions: [
        {
          id: 'd1',
          status: 'PENDING_CONFIRM',
          topic: '我决定买这块显卡',
          decidedAt: day(50),
          confirmedAt: null,
          outcomeRecordedAt: null
        }
      ]
    });
    expect(find(plan.findings, 'MILESTONE')).toBeUndefined();
  });
});

describe('DECISION_LESSON：只有记下结果了才谈经验', () => {
  it('已记录结果的决策 ⇒ 出洞察，引用那条决策', () => {
    const plan = planReflections({
      now: NOW,
      memories: [],
      decisions: [
        {
          id: 'd1',
          status: 'OUTCOME_RECORDED',
          topic: '我决定等降价再买这块显卡',
          decidedAt: day(50),
          confirmedAt: day(52),
          outcomeRecordedAt: day(80)
        }
      ]
    });
    const lesson = find(plan.findings, 'DECISION_LESSON')!;
    expect(lesson.supportDecisionIds).toEqual(['d1']);
    // 时间取 confirmedAt→outcomeRecordedAt 这两个系统时刻：decidedAt 是用户话里的时间，
    //  DecisionRecord 上没带精度列，拿它当精确日期就是任务书门槛 6 不许的那种伪造。
    expect(lesson.timeFrom).toEqual(day(52));
    expect(lesson.timeTo).toEqual(day(80));
    expect(lesson.timePrecision).toBe('TIMESTAMP');
    expect(lesson.observationSpanDays).toBe(28);
  });

  it('确认了但还没提过结果 ⇒ 证据不足，不许凭决策本身总结「经验」', () => {
    const plan = planReflections({
      now: NOW,
      memories: [],
      decisions: [
        {
          id: 'd1',
          status: 'CONFIRMED',
          topic: '我决定等降价再买这块显卡',
          decidedAt: day(50),
          confirmedAt: day(52),
          outcomeRecordedAt: null
        }
      ]
    });
    expect(find(plan.findings, 'DECISION_LESSON')).toBeUndefined();
    expect(find(plan.insufficient, 'DECISION_LESSON')!.reason).toBe('BELOW_OUTCOME_MIN');
  });
});

describe('INTEREST_SHIFT：两个主题都要够样本，中间要够远', () => {
  const postgres = [
    memory({ id: 'p1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
    memory({ id: 'p2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(5) }),
    memory({ id: 'p3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(9) })
  ];
  const swimming = [
    memory({ id: 's1', text: '我打算每周去游泳三次健身', chatId: 'c4', recordedAt: day(120) }),
    memory({ id: 's2', text: '我把每周去游泳三次健身记进日程', chatId: 'c5', recordedAt: day(140) }),
    memory({ id: 's3', text: '我准备每周去游泳三次健身坚持一年', chatId: 'c6', recordedAt: day(160) })
  ];

  it('旧主题三个样本、新主题三个样本、中位数差五十天 ⇒ 出转向', () => {
    const plan = planReflections({ now: NOW, memories: [...postgres, ...swimming] });
    const shift = find(plan.findings, 'INTEREST_SHIFT')!;
    expect(shift.supportMemoryIds).toEqual(['s1', 's2', 's3']);
    expect(shift.counterMemoryIds).toEqual(['p1', 'p2', 'p3']);
    expect(shift.timePrecision).toBe('TIMESTAMP');
  });

  it('两边都够样本但只差十天：还不够说「转向」', () => {
    const recent = [
      memory({ id: 's1', text: '我打算每周去游泳三次健身', chatId: 'c4', recordedAt: day(10) }),
      memory({ id: 's2', text: '我把每周去游泳三次健身记进日程', chatId: 'c5', recordedAt: day(15) }),
      memory({ id: 's3', text: '我准备每周去游泳三次健身坚持一年', chatId: 'c6', recordedAt: day(19) })
    ];
    const plan = planReflections({ now: NOW, memories: [...postgres, ...recent] });
    expect(find(plan.findings, 'INTEREST_SHIFT')).toBeUndefined();
    expect(find(plan.insufficient, 'INTEREST_SHIFT')!.reason).toBe('BELOW_MEDIAN_GAP');
  });

  it('新主题只有两条 ⇒ 样本不足，不预测人生方向', () => {
    const thin = [
      memory({ id: 's1', text: '我打算每周去游泳三次健身', chatId: 'c4', recordedAt: day(120) }),
      memory({ id: 's2', text: '我把每周去游泳三次健身记进日程', chatId: 'c5', recordedAt: day(140) })
    ];
    const plan = planReflections({ now: NOW, memories: [...postgres, ...thin] });
    expect(find(plan.findings, 'INTEREST_SHIFT')).toBeUndefined();
    expect(find(plan.insufficient, 'INTEREST_SHIFT')!.reason).toBe('BELOW_SAMPLE_MIN');
  });

  it('两个阈值都写成常量：这两个数字是要按实测调的，不能埋在 if 里', () => {
    expect(INTEREST_SHIFT_MIN_SAMPLES).toBe(3);
    expect(INTEREST_SHIFT_MEDIAN_GAP_DAYS).toBe(30);
  });
});

describe('去重键与输出稳定性（6.6）', () => {
  const seeds = [
    memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1', recordedAt: day(0) }),
    memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2', recordedAt: day(10) }),
    memory({ id: 'm3', text: '我准备把备份也迁移到 PostgreSQL', chatId: 'c3', recordedAt: day(20) })
  ];

  it('同一批记忆跑两次，dedupKey 一模一样：库里那条唯一约束靠它生效', () => {
    const first = planReflections({ now: NOW, memories: seeds }).findings.find((f) => f.type === 'PATTERN')!;
    const second = planReflections({ now: NOW, memories: [...seeds].reverse() }).findings.find(
      (f) => f.type === 'PATTERN'
    )!;
    expect(second.dedupKey).toBe(first.dedupKey);
    expect(first.dedupKey.length).toBeLessThanOrEqual(80);
  });

  it('不同主题的 dedupKey 不同', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        ...seeds,
        memory({ id: 'k1', text: '我想学大提琴每周练两次琴', chatId: 'c7', recordedAt: day(0) }),
        memory({ id: 'k2', text: '我把大提琴每周练两次琴写进计划', chatId: 'c8', recordedAt: day(10) }),
        memory({ id: 'k3', text: '我准备大提琴每周练两次琴坚持一冬', chatId: 'c9', recordedAt: day(20) })
      ]
    });
    const keys = plan.findings.filter((f) => f.type === 'PATTERN').map((f) => f.dedupKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('输出顺序稳定：按类型再按 dedupKey 排，不依赖传入顺序', () => {
    const a = planReflections({ now: NOW, memories: seeds });
    const b = planReflections({ now: NOW, memories: [...seeds].reverse() });
    expect(b.findings.map((f) => f.dedupKey)).toEqual(a.findings.map((f) => f.dedupKey));
  });

  it('PATTERN 的三个门槛也是常量', () => {
    expect(PATTERN_MIN_SAMPLES).toBe(3);
    expect(PATTERN_MIN_CHATS).toBe(3);
    expect(PATTERN_MIN_SPAN_DAYS).toBe(14);
  });
});

describe('边界：不许无中生有', () => {
  it('空池子什么都不出，也不报证据不足：没素材就不许编洞察', () => {
    const plan = planReflections({ now: NOW, memories: [] });
    expect(plan.findings).toEqual([]);
    expect(plan.insufficient).toEqual([]);
  });

  it('「证据不足」那条结构里不许有主题词：它是 6-D 要落日志的那一条', () => {
    // 日志只带 id 和计数是任务书的红线，而 topicTokens 是用户正文的切片——
    // 留着它，下一个写日志的人顺手带上就是泄露。没人的读侧要它，所以它不该存在。
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1' }),
        memory({ id: 'm2', text: '我把数据库迁移到 PostgreSQL', chatId: 'c2' })
      ]
    });
    const short = find(plan.insufficient, 'PATTERN')!;
    expect(Object.keys(short).sort()).toEqual(['observationSpanDays', 'reason', 'sampleCount', 'type']);
  });

  it('只有一条记忆 ⇒ 任何类型都不出', () => {
    const plan = planReflections({
      now: NOW,
      memories: [memory({ id: 'm1', text: '我打算把项目迁移到 PostgreSQL', chatId: 'c1' })]
    });
    expect(plan.findings).toEqual([]);
  });

  it('切不出词的正文（纯标点）不参与任何规则', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'x1', text: '！！！', chatId: 'c1', recordedAt: day(0) }),
        memory({ id: 'x2', text: '？？？', chatId: 'c2', recordedAt: day(10) }),
        memory({ id: 'x3', text: '。。。', chatId: 'c3', recordedAt: day(20) })
      ]
    });
    expect(plan.findings).toEqual([]);
  });

  it('没有 previousId 的演化边（首版就没有前驱）不能编出一对来', () => {
    const plan = planReflections({
      now: NOW,
      memories: [memory({ id: 'g2', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c2', recordedAt: day(60) })],
      revisions: [{ action: 'SUPERSEDED', memoryId: 'g2', previousId: null, createdAt: day(60) }]
    });
    expect(find(plan.findings, 'GOAL_DRIFT')).toBeUndefined();
    expect(find(plan.findings, 'MILESTONE')).toBeUndefined();
  });

  it('引用指向池子里没有的记忆时按边的两端都要在场才算：不给幽灵记忆出洞察', () => {
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g2', text: '我打算今年把身体练回来然后再考虑比赛', type: 'GOAL', chatId: 'c2', recordedAt: day(60) })
      ],
      revisions: [{ action: 'SUPERSEDED', memoryId: 'g2', previousId: 'g1', createdAt: day(60) }]
    });
    expect(find(plan.findings, 'GOAL_DRIFT')).toBeUndefined();
    const cited = plan.findings.flatMap((f) => [...f.supportMemoryIds, ...f.counterMemoryIds]);
    expect(cited).not.toContain('g1');
  });
});
