import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReflectionFinding, ReflectableMemory, ReflectableRevision } from '@/lib/cognitive/reflection-planner';
import { ALL_HYPOTHESIS_KEYS, HYPOTHESIS_KEYS_BY_TYPE, planReflections } from '@/lib/cognitive/reflection-planner';
import {
  CAUSAL_MARKERS,
  HYPOTHESIS_PHRASES,
  criticizeReflection,
  phraseReflection
} from '@/lib/cognitive/reflection-evidence';
import { describeAlternatives } from '@/lib/cognitive/reflection-display';

/**
 * 片Q-2：多假设扩到五类，而且一句解释只写在一个地方。
 *
 * 任务书 6.3 要的是「多个假设」，可 6-B 落笔时只给 PATTERN 配了三种——理由是「三种解释分不开」，
 * 而这个理由同样适用于 GOAL_DRIFT（目标换了，还是换了走法？）、UNRESOLVED（没下文，是等条件还是已经定了？）、
 * INTEREST_SHIFT（新的占了旧的位子，还是只是这阵子说到的顺序变了？）、DECISION_LESSON（结果是这个决定带来的，
 * 还是同期另一件事、或者环境本来就会这样？）。规则算不出哪一条，就等于替用户选了一条——那是红线。
 * CONTRADICTION 和 MILESTONE 两类**不给**解释，各自有理由：前者的两句原话本身就说了「不做了」，
 * 再猜三种是把已知结论重新猜一遍；后者的「完成」是用户自己宣布的，没有备选解释可给。
 *
 * 第二条要防的是重复渲染。片Q-2 之前，同三句解释既被抄进正文（`分不开这几种解释：…`），
 * 又写进 `alternatives` 列由界面单独渲染一行——一屏里系统同一句话讲了两遍，而落库那份还得
 * 由 sweep 再推导一次（两处推导迟早分叉，这个错在片M 和片P-4 各犯过一次）。
 * 这一片把去处定成一个：措辞层产出 `alternatives`，正文不抄，critic 核 `alternatives`，落库写那一份。
 */

const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

/** 七类反思以 schema 的枚举为准：表多一类或少一类，都不该静悄悄通过。 */
function enumMembers(name: string): string[] {
  const schema = read('prisma/schema.prisma');
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema);
  if (!block) throw new Error(`prisma/schema.prisma 里找不到 enum ${name}`);
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('///') && !line.startsWith('//'));
}

const BASE = new Date('2026-01-01T00:00:00.000Z');
const DAY_MS = 86_400_000;
const day = (offset: number) => new Date(BASE.getTime() + offset * DAY_MS);
const NOW = day(200);

function memory(overrides: Partial<ReflectableMemory> = {}): ReflectableMemory {
  return {
    id: 'm1',
    text: '我打算把项目迁移到 PostgreSQL',
    type: 'FACT',
    origin: 'EXPLICIT',
    chatId: 'c1',
    recordedAt: day(0),
    validFrom: null,
    validPrecision: 'UNKNOWN',
    supersededAt: null,
    ...overrides
  };
}

function finding(overrides: Partial<ReflectionFinding> = {}): ReflectionFinding {
  return {
    type: 'PATTERN',
    dedupKey: 'PATTERN:abc',
    topicTokens: ['数据', '库迁', '迁移'],
    supportMemoryIds: ['m1'],
    counterMemoryIds: [],
    supportDecisionIds: [],
    sampleCount: 3,
    observationSpanDays: 20,
    timeFrom: day(0),
    timeTo: day(20),
    timePrecision: 'UNKNOWN',
    hypothesisKeys: [...HYPOTHESIS_KEYS_BY_TYPE.PATTERN],
    ...overrides
  };
}

const texts = (...rows: ReflectableMemory[]) => new Map(rows.map((row) => [row.id, row.text]));
const SPOKEN = '我打算把项目迁移到 PostgreSQL';

const draftOf = (one: ReflectionFinding) =>
  phraseReflection({
    finding: one,
    band: 'medium',
    memoryTexts: texts(memory({ id: 'm1', text: SPOKEN })),
    decisionTopics: new Map<string, string>(),
    counterHits: 0
  });

describe('哪几类有多假设，一张表说了算', () => {
  it('表的行正好是七类反思：一类不多一类不少，以 schema 的枚举为准', () => {
    expect(Object.keys(HYPOTHESIS_KEYS_BY_TYPE).sort()).toEqual([...enumMembers('ReflectionType')].sort());
  });

  it('五类各三种解释，逐字钉住；CONTRADICTION 和 MILESTONE 一个都不给', () => {
    expect(HYPOTHESIS_KEYS_BY_TYPE).toEqual({
      PATTERN: ['LONG_TERM_INTEREST', 'STAGED_PROJECT', 'TEMPORARY_LEARNING'],
      GOAL_DRIFT: ['GOAL_REPLACED', 'SAME_GOAL_NEW_PATH', 'GOAL_NEVER_PINNED'],
      UNRESOLVED: ['AWAITING_CONDITION', 'DECIDED_UNSPOKEN', 'DEFERRING_IS_ANSWER'],
      INTEREST_SHIFT: ['NEW_TOOK_THE_PLACE', 'BOTH_ORDER_CHANGED', 'OLD_PARKED_FOR_NOW'],
      DECISION_LESSON: ['FROM_THIS_DECISION', 'FROM_SOMETHING_ELSE', 'ENVIRONMENT_ANYWAY'],
      // 数据自己就说了「不做了」，再猜三种等于把已知结论重新猜一遍。
      CONTRADICTION: [],
      // 「完成了」是用户自己宣布的，这一类没有备选解释可给。
      MILESTONE: []
    });
  });

  it('表里出现的每个键都有句子，句子表里出现的每个键都在表里：两边不许各自留一份遗产', () => {
    expect(Object.keys(HYPOTHESIS_PHRASES).sort()).toEqual([...ALL_HYPOTHESIS_KEYS].sort());
    const listed = new Set(Object.values(HYPOTHESIS_KEYS_BY_TYPE).flat());
    expect([...listed].sort()).toEqual([...ALL_HYPOTHESIS_KEYS].sort());
  });

  it('每句解释都以「可能」开头，不带因果词也不带数字：解释是候选，不是结论', () => {
    for (const key of ALL_HYPOTHESIS_KEYS) {
      const phrase = HYPOTHESIS_PHRASES[key];
      expect(phrase.startsWith('可能')).toBe(true);
      expect(CAUSAL_MARKERS.some((marker) => phrase.includes(marker))).toBe(false);
      expect(/\d/.test(phrase)).toBe(false);
    }
  });
});

describe('规则真的把这一行的解释交出去', () => {
  it('GOAL_DRIFT：目标被新目标取代 ⇒ 带着这一类的三种解释，不是 PATTERN 那三种', () => {
    const revisions: ReflectableRevision[] = [
      { action: 'SUPERSEDED', memoryId: 'g2', previousId: 'g1', createdAt: day(60) }
    ];
    const plan = planReflections({
      now: NOW,
      memories: [
        memory({ id: 'g1', text: '我打算今年把身体练回来', type: 'GOAL', chatId: 'c1', recordedAt: day(0), supersededAt: day(60) }),
        memory({
          id: 'g2',
          text: '我打算今年把身体练回来然后再考虑比赛',
          type: 'GOAL',
          chatId: 'c2',
          recordedAt: day(60)
        })
      ],
      revisions
    });
    const drift = plan.findings.find((one) => one.type === 'GOAL_DRIFT')!;
    expect(drift.hypothesisKeys).toHaveLength(3);
    expect(drift.hypothesisKeys).toEqual([...HYPOTHESIS_KEYS_BY_TYPE.GOAL_DRIFT]);
  });

  it('UNRESOLVED：目标满六十天没下文 ⇒ 三种解释一起给，不替用户断定他在等什么', () => {
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
    const unresolved = plan.findings.find((one) => one.type === 'UNRESOLVED')!;
    expect(unresolved.hypothesisKeys).toHaveLength(3);
    expect(unresolved.hypothesisKeys).toEqual([...HYPOTHESIS_KEYS_BY_TYPE.UNRESOLVED]);
  });

  it('INTEREST_SHIFT：两个主题都够样本 ⇒ 三种解释一起给，不说「你变了」', () => {
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
    const plan = planReflections({ now: NOW, memories: [...postgres, ...swimming] });
    const shift = plan.findings.find((one) => one.type === 'INTEREST_SHIFT')!;
    expect(shift.hypothesisKeys).toHaveLength(3);
    expect(shift.hypothesisKeys).toEqual([...HYPOTHESIS_KEYS_BY_TYPE.INTEREST_SHIFT]);
  });

  it('DECISION_LESSON：报了结果的决策 ⇒ 三种解释一起给，不替用户认领因果', () => {
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
    const lesson = plan.findings.find((one) => one.type === 'DECISION_LESSON')!;
    expect(lesson.hypothesisKeys).toHaveLength(3);
    expect(lesson.hypothesisKeys).toEqual([...HYPOTHESIS_KEYS_BY_TYPE.DECISION_LESSON]);
  });
});

describe('解释只渲染一处', () => {
  it('正文里一句解释都不出现：那一行是界面单独渲染的，正文不抄第二遍', () => {
    const draft = draftOf(finding());
    for (const key of HYPOTHESIS_KEYS_BY_TYPE.PATTERN) {
      expect(draft.body).not.toContain(HYPOTHESIS_PHRASES[key]);
    }
    expect(draft.body).not.toContain('解释');
  });

  it('三句解释按表里的顺序落在 alternatives 里，用「；」连着——文案逐字钉住', () => {
    expect(draftOf(finding()).alternatives).toBe(
      '可能是你长期在意的事；可能是一个分几步推进的事；可能只是这一阵子在看的东西'
    );
  });

  it('换一类洞察就换一套解释：DECISION_LESSON 拿到的不是 PATTERN 那三句', () => {
    const draft = draftOf(finding({ type: 'DECISION_LESSON', hypothesisKeys: [...HYPOTHESIS_KEYS_BY_TYPE.DECISION_LESSON] }));
    expect(draft.alternatives).toContain(HYPOTHESIS_PHRASES.FROM_THIS_DECISION);
    expect(draft.alternatives).toContain(HYPOTHESIS_PHRASES.ENVIRONMENT_ANYWAY);
    expect(draft.alternatives).not.toContain(HYPOTHESIS_PHRASES.LONG_TERM_INTEREST);
  });

  it('没有解释的那两类：alternatives 是空串，界面那一行整个不留', () => {
    const draft = draftOf(finding({ type: 'CONTRADICTION', hypothesisKeys: [] }));
    expect(draft.alternatives).toBe('');
    expect(describeAlternatives(draft.alternatives)).toBe('');
  });
});

describe('critic 核的就是那一个去处', () => {
  const cleanFinding = finding({ supportMemoryIds: ['m1'] });
  const cleanDraft = draftOf(cleanFinding);
  const input = (draft = cleanDraft) => ({
    finding: cleanFinding,
    draft,
    counterHits: 0,
    poolIds: ['m1'],
    supportTexts: [SPOKEN]
  });

  it('三句都在 alternatives 里 ⇒ 通过', () => {
    expect(criticizeReflection(input())).toEqual({ accepted: true, reasons: [] });
  });

  it('少一句解释 ⇒ HYPOTHESIS_DROPPED：一条都不许替用户选掉', () => {
    const dropped = { ...cleanDraft, alternatives: cleanDraft.alternatives.replace(HYPOTHESIS_PHRASES.STAGED_PROJECT, '') };
    expect(criticizeReflection(input(dropped)).reasons).toContain('HYPOTHESIS_DROPPED');
  });

  it('三句只在正文里留着、alternatives 交白卷 ⇒ 照样挡下：正文不再是那一个去处', () => {
    const movedBack = { ...cleanDraft, body: `${cleanDraft.body}${cleanDraft.alternatives}`, alternatives: '' };
    expect(criticizeReflection(input(movedBack)).reasons).toContain('HYPOTHESIS_DROPPED');
  });

});
