import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReflectionFinding, ReflectableMemory } from '@/lib/cognitive/reflection-planner';
import { PATTERN_HYPOTHESES } from '@/lib/cognitive/reflection-planner';
import {
  REFLECTION_TITLE_MAX_CHARS,
  criticizeReflection,
  phraseReflection
} from '@/lib/cognitive/reflection-evidence';

/**
 * 洞察的标题（任务书 6.4 的第一项）。
 *
 * 为什么不改到 `cognitive-reflection-evidence.test.ts` 里：那一份文件里有一条断言钉着旧口径
 * （标题就是类型标签），把它留在那儿改，红的时候整片一起红，分不清是新行为没实现还是老断言没跟上。
 * 新口径先在这里单独红一次，实现完再把那一条改成新口径。
 *
 * 这一片真正要防的只有一件事：**标题是这一屏最大的一号字，系统绝不能拿它替用户造一句话。**
 * 所以标题的取材和正文的引号用的是同一条纪律——只能从这条洞察自己引用的那几行里逐字取，
 * 取不到就空着让 critic 把整条挡下，而不是退回到「两句互相打脸」这种听起来像总结其实什么也没说的标签。
 */

const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

const EVIDENCE_CODE = stripComments(read('src/lib/cognitive/reflection-evidence.ts'));
const DISPLAY_CODE = read('src/lib/cognitive/reflection-display.ts');

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
    supportMemoryIds: ['m1'],
    counterMemoryIds: [],
    supportDecisionIds: [],
    sampleCount: 3,
    observationSpanDays: 20,
    timeFrom: day(0),
    timeTo: day(20),
    timePrecision: 'UNKNOWN',
    hypothesisKeys: [...PATTERN_HYPOTHESES],
    ...overrides
  };
}

const texts = (...rows: ReflectableMemory[]) => new Map(rows.map((row) => [row.id, row.text]));

describe('标题从这条洞察自己的证据里逐字取', () => {
  it('支持证据是记忆 ⇒ 标题就是那句原话，带引号', () => {
    const draft = phraseReflection({
      finding: finding(),
      band: 'medium',
      memoryTexts: texts(memory()),
      decisionTopics: new Map(),
      counterHits: 0
    });
    expect(draft.title).toBe('「我打算把项目迁移到 PostgreSQL」');
  });

  it('支持证据是决策行 ⇒ 标题取那条决策的 topic，同样是用户自己的话', () => {
    const draft = phraseReflection({
      finding: finding({ type: 'DECISION_LESSON', supportMemoryIds: [], supportDecisionIds: ['d1'] }),
      band: 'medium',
      memoryTexts: texts(),
      decisionTopics: new Map([['d1', '我决定把周报改成邮件']]),
      counterHits: 0
    });
    expect(draft.title).toBe('「我决定把周报改成邮件」');
  });

  it('取最近那一句，不是最早那一句：这一屏要说的是「现在这件事长什么样」', () => {
    const draft = phraseReflection({
      finding: finding({ type: 'CONTRADICTION', supportMemoryIds: ['m1', 'm2'] }),
      band: 'medium',
      memoryTexts: texts(memory({ id: 'm1', text: '我家住在杭州' }), memory({ id: 'm2', text: '我家不在杭州' })),
      decisionTopics: new Map(),
      counterHits: 0
    });
    expect(draft.title).toBe('「我家不在杭州」');
  });

  it('长过上限时按分句边界截，截断处补「…」；截下来的部分仍是原话的子串', () => {
    const long = '我打算把项目迁移到 PostgreSQL，先把读接口稳住，再动写路径，最后才删旧库';
    const draft = phraseReflection({
      finding: finding({ supportMemoryIds: ['m9'] }),
      band: 'medium',
      memoryTexts: texts(memory({ id: 'm9', text: long })),
      decisionTopics: new Map(),
      counterHits: 0
    });
    expect(draft.title.endsWith('…」')).toBe(true);
    const inner = draft.title.slice(1, -2);
    expect(inner.length).toBeLessThanOrEqual(REFLECTION_TITLE_MAX_CHARS + 1);
    expect(long.startsWith(inner.replace(/…$/, ''))).toBe(true);
    // 截断只落在分句边界上——绝不把一句话拦腰切断。
    expect(inner.replace(/…$/, '').includes('，')).toBe(false);
    expect(inner.replace(/…$/, '')).toBe('我打算把项目迁移到 PostgreSQL');
  });

  it('第一个分句本身就超长 ⇒ 按字数硬切，但只按**字**切：绝不把一个字拆成半个', () => {
    // 39 个汉字 + 一枚要两个 UTF-16 单元才装得下的表情 + 尾巴。上限 40 正好落在那枚表情中间：
    // 按单元切会切出半个字符，界面就是一个乱码方块——而它是这一屏最大的一号字。
    const long = `${'一'.repeat(REFLECTION_TITLE_MAX_CHARS - 1)}🙂后面还有话`;
    const draft = phraseReflection({
      finding: finding({ supportMemoryIds: ['m9'] }),
      band: 'medium',
      memoryTexts: texts(memory({ id: 'm9', text: long })),
      decisionTopics: new Map(),
      counterHits: 0
    });
    expect(draft.title).toBe(`「${'一'.repeat(REFLECTION_TITLE_MAX_CHARS - 1)}🙂…」`);
  });

  it('一句原话都拿不到 ⇒ 标题是空串：宁可不落这一行，也不摆一句系统自己编的总结', () => {
    const draft = phraseReflection({
      finding: finding({ supportMemoryIds: ['ghost'] }),
      band: 'medium',
      memoryTexts: texts(),
      decisionTopics: new Map(),
      counterHits: 0
    });
    expect(draft.title).toBe('');
  });
});

describe('critic 把「标题不是原话」当成一条不写库的理由', () => {
  const f = finding();
  const cleanDraft = phraseReflection({
    finding: f,
    band: 'medium',
    memoryTexts: texts(memory()),
    decisionTopics: new Map(),
    counterHits: 0
  });
  /** 只换 draft 的这一对；其余检查的输入保持原样，这样 reason 数组里只可能多出标题那一条。 */
  const input = (draft = cleanDraft) => ({
    finding: f,
    draft,
    counterHits: 0,
    poolIds: ['m1'],
    // critic 核标题要的那份支持证据原文：这里就是措辞层自己拿到的那一句，正常路径下必然对得上。
    supportTexts: ['我打算把项目迁移到 PostgreSQL']
  });

  it('正常那条：标题就是引用行的原话 ⇒ 通过', () => {
    expect(criticizeReflection(input())).toEqual({ accepted: true, reasons: [] });
  });

  it('标题里引号包住的不是任何一条支持证据的原话 ⇒ TITLE_NOT_SOURCED', () => {
    const verdict = criticizeReflection(input({ title: '「你其实一直很在意效率」', body: cleanDraft.body }));
    expect(verdict.reasons).toContain('TITLE_NOT_SOURCED');
    expect(verdict.accepted).toBe(false);
  });

  it('标题为空 ⇒ 一样挡下：没取材的标题不许占这一屏最大的一号字', () => {
    expect(criticizeReflection(input({ title: '', body: cleanDraft.body })).reasons).toEqual(['TITLE_NOT_SOURCED']);
  });
});

describe('类型标签只许有一处', () => {
  it('措辞层不再自备一张标签表：标题既然不取自它，留着就是第二套类型名', () => {
    expect(EVIDENCE_CODE).not.toContain('REFLECTION_TYPE_LABELS');
    expect(DISPLAY_CODE).toContain('REFLECTION_TYPE_LABELS');
  });
});
