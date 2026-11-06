import { describe, expect, it } from 'vitest';
import type { ReflectionType } from '@prisma/client';
import type { ReflectionFinding, ReflectableMemory } from '@/lib/cognitive/reflection-planner';
import { HYPOTHESIS_KEYS_BY_TYPE, NEGATION_MARKERS } from '@/lib/cognitive/reflection-planner';
import {
  CAUSAL_MARKERS,
  CONF_COUNTER_MAX_COUNTED,
  CONF_COUNTER_PENALTY,
  CONF_SAMPLES_FULL,
  CONF_SPAN_FULL_DAYS,
  COUNTER_CLAUSE,
  HEDGE_MARKERS,
  HIGH_BAND_MIN,
  HYPOTHESIS_PHRASES,
  MEDIUM_BAND_MIN,
  QUOTE_MAX,
  criticizeReflection,
  findCounterEvidence,
  phraseReflection,
  reflectionConfidence
} from '@/lib/cognitive/reflection-evidence';

/**
 * 6-C 反证搜索 + 置信度 + 措辞 + EvidenceCritic。
 *
 * 零模型：判据全是读进去的那几行行，措辞全从常量表里选。
 * 这里最怕的两件事是「把无关的行说成反证」和「正文里的数字不是 finding 里的那个」，
 * 所以两边各有独立断言，而且每条断言都必须无条件成立。
 */

const BASE = new Date('2026-01-01T00:00:00.000Z');
const DAY_MS = 86_400_000;
const day = (offset: number) => new Date(BASE.getTime() + offset * DAY_MS);

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
    supportMemoryIds: [],
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

const poolOf = (...rows: ReflectableMemory[]) => rows;
const texts = (...rows: ReflectableMemory[]) => new Map(rows.map((row) => [row.id, row.text]));

describe('反证搜索：只有两个确定性信号，不猜语义', () => {
  it('主题命中、带否定词而支持行一个都不带 ⇒ 这才是反证', () => {
    const pool = poolOf(memory({ id: 's1', text: '我家住在杭州' }), memory({ id: 'x1', text: '我家不在杭州' }));
    expect(findCounterEvidence(finding({ topicTokens: ['杭州'], supportMemoryIds: ['s1'] }), pool)).toEqual(['x1']);
  });

  it('支持行里已经有同一个否定标记 ⇒ 方向不算相反，不能拿来打脸自己', () => {
    const pool = poolOf(memory({ id: 's1', text: '我不打算换工作' }), memory({ id: 'x1', text: '我没打算加班' }));
    expect(findCounterEvidence(finding({ topicTokens: ['打算'], supportMemoryIds: ['s1'] }), pool)).toEqual([]);
  });

  it('主题命中但已经被取代 ⇒ 用户改过口，算反证', () => {
    const pool = poolOf(
      memory({ id: 's1' }),
      memory({ id: 'x1', text: '我打算把数据库迁移到 PostgreSQL', supersededAt: day(50) })
    );
    expect(findCounterEvidence(finding({ supportMemoryIds: ['s1'] }), pool)).toEqual(['x1']);
  });

  it('主题命中但已撤回 ⇒ 算反证', () => {
    const pool = poolOf(
      memory({ id: 's1' }),
      memory({ id: 'x1', text: '我把数据库迁移到 PostgreSQL', origin: 'RETRACTED' })
    );
    expect(findCounterEvidence(finding({ supportMemoryIds: ['s1'] }), pool)).toEqual(['x1']);
  });

  it('这条洞察已经引用过的行不再当成新反证：支持侧和反对侧都不许重复计数', () => {
    const pool = poolOf(memory({ id: 's1', text: '我家住在杭州' }), memory({ id: 'x1', text: '我家不在杭州' }));
    const hit = finding({ topicTokens: ['杭州'], supportMemoryIds: ['s1'], counterMemoryIds: ['x1'] });
    expect(findCounterEvidence(hit, pool)).toEqual([]);
  });

  it('主题词一个都不命中 ⇒ 一条都不给', () => {
    const pool = poolOf(memory({ id: 's1' }), memory({ id: 'x1', text: '我今天去跑了五公里' }));
    expect(findCounterEvidence(finding({ supportMemoryIds: ['s1'] }), pool)).toEqual([]);
  });

  it('引用了池子里没有的行 ⇒ 不报错也不返回它：那是 critic 的活', () => {
    const pool = poolOf(memory({ id: 'x1', text: '我家不在杭州' }));
    expect(findCounterEvidence(finding({ topicTokens: ['杭州'], supportMemoryIds: ['ghost'] }), pool)).toEqual([]);
  });

  it('没有支持行时不许把整个池子都当反证：没有基线就没有「方向相反」这回事', () => {
    const pool = poolOf(memory({ id: 'x1', text: '我打算把数据库迁移到 PostgreSQL' }), memory({ id: 'x2', text: '我把数据库迁移完成了' }));
    expect(findCounterEvidence(finding({ supportMemoryIds: ['ghost'] }), pool)).toEqual([]);
  });

  it('主题词表为空 ⇒ 不搜：没有查询串就不许给任何行打「相关」', () => {
    const pool = poolOf(memory({ id: 's1' }));
    expect(findCounterEvidence(finding({ topicTokens: [] }), pool)).toEqual([]);
  });

  it('返回的 id 按正文时间倒序：多条反证先给用户看最近那次', () => {
    const pool = poolOf(
      memory({ id: 's1', text: '我家住在杭州' }),
      memory({ id: 'x1', text: '我家不在杭州', recordedAt: day(10) }),
      memory({ id: 'x2', text: '我家不在杭州了', recordedAt: day(30) })
    );
    expect(findCounterEvidence(finding({ topicTokens: ['杭州'], supportMemoryIds: ['s1'] }), pool)).toEqual(['x2', 'x1']);
  });

  it('否定标记表是导出的常量，并且是四个单字', () => {
    expect(NEGATION_MARKERS).toEqual(['不', '没', '无', '别']);
  });
});

describe('反思置信度：三个因子，档位常量写出来', () => {
  it('六个数都写成常量：这些要按实测调，不许埋在算式里', () => {
    expect(HIGH_BAND_MIN).toBe(0.7);
    expect(MEDIUM_BAND_MIN).toBe(0.4);
    expect(CONF_SAMPLES_FULL).toBe(6);
    expect(CONF_SPAN_FULL_DAYS).toBe(60);
    expect(CONF_COUNTER_PENALTY).toBe(0.2);
    expect(CONF_COUNTER_MAX_COUNTED).toBe(3);
  });

  it('样本够、跨度够、无反证 ⇒ 满分 high', () => {
    expect(reflectionConfidence({ sampleCount: 6, observationSpanDays: 60, counterHits: 0 })).toEqual({
      score: 1,
      band: 'high'
    });
  });

  it('只有一条、只有一天 ⇒ low，不给最肯定那一档措辞', () => {
    const result = reflectionConfidence({ sampleCount: 1, observationSpanDays: 1, counterHits: 0 });
    expect(result.band).toBe('low');
    expect(result.score).toBeLessThan(MEDIUM_BAND_MIN);
  });

  it('反证按条数扣分：两条就把满分拉到 medium', () => {
    expect(reflectionConfidence({ sampleCount: 6, observationSpanDays: 60, counterHits: 2 })).toEqual({
      score: 0.6,
      band: 'medium'
    });
  });

  it('反证扣分有上限：九条也只按三条扣，一条洞察不该被反证扣到负分', () => {
    expect(reflectionConfidence({ sampleCount: 6, observationSpanDays: 60, counterHits: 9 })).toEqual({
      score: 0.4,
      band: 'medium'
    });
  });

  it('样本变多不降分，反证变多不升分：两个方向的单调性', () => {
    const less = reflectionConfidence({ sampleCount: 2, observationSpanDays: 20, counterHits: 1 });
    const more = reflectionConfidence({ sampleCount: 5, observationSpanDays: 20, counterHits: 1 });
    expect(more.score).toBeGreaterThan(less.score);
    expect(reflectionConfidence({ sampleCount: 5, observationSpanDays: 20, counterHits: 0 }).score).toBeGreaterThan(
      more.score
    );
  });

  it('分数永远落在 0 到 1：负分不是一个可信度', () => {
    expect(reflectionConfidence({ sampleCount: 0, observationSpanDays: 0, counterHits: 3 })).toEqual({
      score: 0,
      band: 'low'
    });
  });
});

describe('措辞：正文只引用用户自己的话，数字只来自 finding', () => {
  const cited = [memory({ id: 's1' })];
  const base = {
    finding: finding({ supportMemoryIds: ['s1'], sampleCount: 4, observationSpanDays: 27 }),
    band: 'medium' as const,
    memoryTexts: texts(...cited),
    decisionTopics: new Map<string, string>(),
    counterHits: 0
  };

  it('正文带上 finding 里那两个数，而不是模板自带的数', () => {
    const draft = phraseReflection(base);
    expect(draft.body).toContain('4');
    expect(draft.body).toContain('27');
  });

  it('引用用户原话时用引号包住：那是「我自己说过的话」，不是系统给的定性', () => {
    expect(phraseReflection(base).body).toContain('「我打算把项目迁移到 PostgreSQL」');
  });

  it('引用条数有上限：一条洞察正文不该变成把用户的话抄一遍', () => {
    expect(QUOTE_MAX).toBe(3);
    const many = [1, 2, 3, 4, 5].map((index) => memory({ id: `s${index}`, text: `我说过第六${index}句` }));
    const draft = phraseReflection({
      ...base,
      finding: finding({ supportMemoryIds: many.map((row) => row.id), sampleCount: 5, observationSpanDays: 27 }),
      memoryTexts: texts(...many)
    });
    expect([...draft.body.matchAll(/「[^」]*」/g)].length).toBe(3);
    // 引了 3 句但仍然是 5 次：数字说计数，引文只作样本。
    expect(draft.body).toContain('5');
  });

  it('PATTERN 无论哪一档都把三种解释一起交出来：分不开就一条都不选', () => {
    for (const band of ['low', 'medium', 'high'] as const) {
      const draft = phraseReflection({ ...base, band });
      for (const key of HYPOTHESIS_KEYS_BY_TYPE.PATTERN) {
        // 解释只在 alternatives 这一处（正文抄第二遍就是同一屏里系统把同一句话说两次）。
        expect(draft.alternatives).toContain(HYPOTHESIS_PHRASES[key]);
        expect(draft.body).not.toContain(HYPOTHESIS_PHRASES[key]);
      }
    }
  });

  it('非 PATTERN 类型不硬塞三种解释：CONTRADICTION 说的是两句打脸，不是三种猜想', () => {
    const body = phraseReflection({
      ...base,
      finding: finding({ type: 'CONTRADICTION', hypothesisKeys: [], supportMemoryIds: ['s1'] })
    }).body;
    expect(body).not.toContain('可能');
  });

  it('决策型洞察用决策行的 topic 短句，不硬拼词元', () => {
    const body = phraseReflection({
      finding: finding({
        type: 'DECISION_LESSON',
        hypothesisKeys: [...HYPOTHESIS_KEYS_BY_TYPE.DECISION_LESSON],
        supportDecisionIds: ['d1'],
        topicTokens: []
      }),
      band: 'medium',
      memoryTexts: new Map<string, string>(),
      decisionTopics: new Map([['d1', '我决定等降价再买这块显卡']]),
      counterHits: 0
    }).body;
    expect(body).toContain('「我决定等降价再买这块显卡」');
  });

  it('拿不到原文时不许编：正文里不能出现任何引号包住的「原话」', () => {
    expect(phraseReflection({ ...base, memoryTexts: new Map<string, string>() }).body).not.toContain('「');
  });

  it('有反证就写一句留出余地，没有反证就不写', () => {
    expect(phraseReflection({ ...base, counterHits: 2 }).body).toContain(COUNTER_CLAUSE);
    expect(phraseReflection(base).body).not.toContain(COUNTER_CLAUSE);
  });

  it('标题取自支持证据的原话，不复述类型标签：类型名只在界面那枚 chip 上出现一次', () => {
    expect(phraseReflection(base).title).toBe('「我打算把项目迁移到 PostgreSQL」');
  });

  it('同一条 finding 措辞两次结果一致：落库的正文不该取决于进程状态', () => {
    expect(phraseReflection(base)).toEqual(phraseReflection(base));
  });
});

describe('EvidenceCritic：六道规则在落库前拦', () => {
  const cleanFinding = finding({ supportMemoryIds: ['s1'], sampleCount: 4, observationSpanDays: 27 });
  const cleanDraft = phraseReflection({
    finding: cleanFinding,
    band: 'medium',
    memoryTexts: texts(memory({ id: 's1' })),
    decisionTopics: new Map<string, string>(),
    counterHits: 0
  });
  const cleanInput = {
    finding: cleanFinding,
    draft: cleanDraft,
    counterHits: 0,
    poolIds: ['s1'],
    // critic 核标题要有对照物：这里给的就是那条支持证据的原文，和措辞层拿到的是同一句。
    supportTexts: ['我打算把项目迁移到 PostgreSQL']
  };

  it('干净的一条通过，且原因列表为空', () => {
    expect(criticizeReflection(cleanInput)).toEqual({ accepted: true, reasons: [] });
  });

  it('引用了池子里没有的行 ⇒ GHOST_CITATION', () => {
    expect(criticizeReflection({ ...cleanInput, poolIds: ['other'] }).reasons).toContain('GHOST_CITATION');
  });

  it('正文里出现因果断言 ⇒ UNSOURCED_ASSERTION：规则给不出「为什么」', () => {
    for (const marker of CAUSAL_MARKERS) {
      const reasons = criticizeReflection({
        ...cleanInput,
        draft: { ...cleanDraft, body: `${cleanDraft.body}${marker}你还在意这件事` }
      }).reasons;
      expect(reasons).toContain('UNSOURCED_ASSERTION');
    }
  });

  it('有反证却一句都没提 ⇒ COUNTER_UNMENTIONED：不许只报好消息', () => {
    // 用 CONTRADICTION 测：它没有假设句可以顺带对冲，余地只能来自那一句反证从句。
    const one = finding({ type: 'CONTRADICTION', hypothesisKeys: [], supportMemoryIds: ['s1'] });
    const hedged = phraseReflection({
      finding: one,
      band: 'high',
      memoryTexts: texts(memory({ id: 's1' })),
      decisionTopics: new Map<string, string>(),
      counterHits: 2
    });
    expect(hedged.body).toContain(COUNTER_CLAUSE);
    const s1Text = '我打算把项目迁移到 PostgreSQL';
    const args = { finding: one, counterHits: 2, poolIds: ['s1'], supportTexts: [s1Text] };
    expect(criticizeReflection({ ...args, draft: hedged }).accepted).toBe(true);
    const stripped = { ...hedged, body: hedged.body.replace(COUNTER_CLAUSE, '') };
    expect(criticizeReflection({ ...args, draft: stripped }).reasons).toContain('COUNTER_UNMENTIONED');
  });

  it('引号里的数字不算系统的数：用户说过「PostgreSQL 16」不该把洞察自己判死', () => {
    const one = finding({ type: 'CONTRADICTION', hypothesisKeys: [], supportMemoryIds: ['s1'], sampleCount: 2, observationSpanDays: 5 });
    const draft = phraseReflection({
      finding: one,
      band: 'medium',
      memoryTexts: new Map([['s1', '我把数据库升到了 PostgreSQL 16']]),
      decisionTopics: new Map<string, string>(),
      counterHits: 0
    });
    expect(draft.body).toContain('16');
    expect(
      criticizeReflection({
        finding: one,
        draft,
        counterHits: 0,
        poolIds: ['s1'],
        supportTexts: ['我把数据库升到了 PostgreSQL 16']
      }).reasons
    ).toEqual([]);
  });

  it('正文里的数字不在 finding 里 ⇒ COUNT_MISMATCH：数字只有一个出处', () => {
    const reasons = criticizeReflection({
      ...cleanInput,
      draft: { ...cleanDraft, body: `${cleanDraft.body}一共 12 次` }
    }).reasons;
    expect(reasons).toContain('COUNT_MISMATCH');
  });

  it('PATTERN 少了一个解释 ⇒ HYPOTHESIS_DROPPED：三种都得到', () => {
    const dropped = {
      ...cleanDraft,
      alternatives: cleanDraft.alternatives.replace(HYPOTHESIS_PHRASES.STAGED_PROJECT, '')
    };
    expect(criticizeReflection({ ...cleanInput, draft: dropped }).reasons).toContain('HYPOTHESIS_DROPPED');
  });

  it('finding 里出现没有措辞的假设键时按少写处理：不静默通过', () => {
    const one = finding({ hypothesisKeys: ['LONG_TERM_INTEREST', 'NOT_A_KEY'], supportMemoryIds: ['s1'] });
    const draft = phraseReflection({
      finding: one,
      band: 'medium',
      memoryTexts: texts(memory({ id: 's1' })),
      decisionTopics: new Map<string, string>(),
      counterHits: 0
    });
    expect(criticizeReflection({ ...cleanInput, finding: one, draft }).reasons).toContain('HYPOTHESIS_DROPPED');
  });

  it('原因码只有大写字母和下划线：日志和接口都不该拿到中文句子', () => {
    const result = criticizeReflection({ ...cleanInput, poolIds: [] });
    expect(result.accepted).toBe(false);
    expect(result.reasons.every((reason) => /^[A-Z_]+$/.test(reason))).toBe(true);
  });

  it('六道全中时按字典序返回，不依赖命中顺序', () => {
    const bad = { title: 'x', body: '一共 99 次 因为 说明', alternatives: '' };
    const first = criticizeReflection({ ...cleanInput, draft: bad, counterHits: 5, poolIds: [] });
    const second = criticizeReflection({ ...cleanInput, draft: bad, counterHits: 5, poolIds: [] });
    expect(first.reasons).toEqual([
      'COUNTER_UNMENTIONED',
      'COUNT_MISMATCH',
      'GHOST_CITATION',
      'HYPOTHESIS_DROPPED',
      'TITLE_NOT_SOURCED',
      'UNSOURCED_ASSERTION'
    ]);
    expect(second.reasons).toEqual(first.reasons);
  });

  it('七类各自的措辞产物都能通过 critic：模板和规则不许互相打脸', () => {
    const row = memory({ id: 's1' });
    const types: ReflectionType[] = [
      'PATTERN',
      'GOAL_DRIFT',
      'UNRESOLVED',
      'INTEREST_SHIFT',
      'CONTRADICTION',
      'MILESTONE',
      'DECISION_LESSON'
    ];
    for (const type of types) {
      const one = finding({
        type,
        supportMemoryIds: ['s1'],
        hypothesisKeys: [...HYPOTHESIS_KEYS_BY_TYPE[type]],
        topicTokens: type === 'CONTRADICTION' ? ['杭州'] : ['数据', '迁移']
      });
      const draft = phraseReflection({
        finding: one,
        band: 'high',
        memoryTexts: texts(row),
        decisionTopics: new Map<string, string>(),
        counterHits: 0
      });
      const result = criticizeReflection({
        finding: one,
        draft,
        counterHits: 0,
        poolIds: ['s1'],
        supportTexts: [row.text]
      });
      expect({ type, reasons: result.reasons }).toEqual({ type, reasons: [] });
    }
  });

  it('对冲词表与因果词表都是导出常量，且互不重叠', () => {
    expect(HEDGE_MARKERS.length).toBeGreaterThan(0);
    expect(CAUSAL_MARKERS.length).toBeGreaterThan(0);
    expect(HEDGE_MARKERS.filter((marker) => CAUSAL_MARKERS.includes(marker))).toEqual([]);
  });
});
