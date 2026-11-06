import { describe, expect, it } from 'vitest';
import type { EvidenceCounts } from '@/lib/cognitive/evidence';
import { MEMORY_READ_MAX_ITEMS, selectMemoryCandidates } from '@/lib/cognitive/memory-module';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import { scoreByKeyword } from '@/lib/cognitive/retrieval';
import { isMemoryUsable } from '@/lib/cognitive/retention';
import type { MemoryDto, MemoryOrigin } from '@/lib/cognitive/memories';
import { allMemories, allProbes } from '../../scripts/cognitive-eval/fixtures/stories';
import type { EvalProbe } from '../../scripts/cognitive-eval/fixture-types';
import { buildPool, EVAL_NOW } from '../../scripts/cognitive-eval/harness';

/**
 * Salience Ranking 的实测（任务书 3.4 六项召回能力里的第五项）。
 *
 * 结论先说：**四个变体没有一个够得上接线，显著性排序不接进读侧。**
 * 这个文件按 2a（RELATED_TO 阈值校准）的先例办——打分器写在测试里而不是 src 里，
 * 因为它没有生产调用方；它存在的意义是把下面这串数字钉住，
 * 防止以后有人随手挑个权重就把 salience 装上（3.4 末段要的是「以实测效果确定权重」，
 * 而这份实测给出的权重是「零」）。
 *
 * 判据两条，和 7.2 的 A/B 一样缺一不可：
 * 一、总收益：Recall@8 / MRR / 违禁项至少动一项，其余不劣。
 * 二、逐问不许退步：任何一个提问的命中数不许比现状少。
 *
 * 实测（116 个提问、此刻可见的池子、同一个保留期过滤和同一个渲染口径）：
 *
 * | 变体 | Recall@8 | Precision@8 | MRR | 违禁项 |
 * |---|---|---|---|---|
 * | 现状（关键词） | 0.7274 | 0.0970 | 0.5828 | 0 |
 * | 兜底按来源重排 | 0.7181 | 0.0959 | 0.5814 | 0 |
 * | 兜底按证据条数重排 | 0.7274 | 0.0970 | 0.5830 | 0 |
 * | 整池 RRF（来源） | 0.7181 | 0.0959 | 0.3975 | 0 |
 * | 整池 RRF（证据） | 0.6900 | 0.0927 | 0.3760 | 0 |
 *
 * 三条读出来的东西比这张表重要：
 *
 * 一、**兜底那几格换人不换分数**。「按证据条数重排」总分和现状一位小数都不差（0.7274 / 0.0970），
 * 但它靠的是两处换来两处：s3-p1、s21-p1 从命中掉成不命中，s14-p1、s25-p1 从不命中变成命中。
 * 判据二就是为这种「总分不动、具体用户变差」准备的，它这一次把这条路挡死了。
 * 掉的和得的都不是因为「标准答案被降权」——兜底位的总数就那么几个，
 * 显著性高的行插进前排，掉出去的是原本卡在边界上的那一行。机制记在最后那个用例里。
 *
 * 二、**整池 RRF 把排序搞坏了**。MRR 0.5828 → 0.3975（来源）/ 0.3760（证据）：
 * 一条零词可比但显著性高的行挤进前排，代价是第一命中从第 1 位掉到第 2～4 位。
 * 这和 5d 向量臂能成是两回事——向量那一路的分数本身带「这一条在讲这件事」的信息，
 * 显著性不带，它只知道这条值不值得信，不知道它跟这一问有没有关系。
 *
 * 三、**Precision@8 只有 0.0970，而这不是排序问题**：每轮 8 格里平均只有 0.78 格是这一问该答的，
 * 剩下 7.2 格是零词可比的兜底。兜底里再怎么排都不会凭空出现相关项——116 个提问里有 21 个
 * 一条标准答案都没捞到，这 21 个是「够不着」，不是「排错了」。救它们的是语义可达（3.4 第一项），
 * 也就是向量臂，不是 salience。
 *
 * 四、**违禁项那一列五个臂全是 0，而这不是空跑**：此刻的池子里就有 20 行是某些提问明令不该出现的
 * （被取代的旧说法、已失效的、跨会话不该带的），一条都没被端出去。这功劳是保留期过滤和关键词口径的，
 * 不是显著性的——所以 salience 在这个指标上也没有可声称的收益。
 *
 * 显著性为什么在这个语料上根本没有抓手，数字也记在这里：候选池此刻 186 行，
 * origin 的分布是 explicit 166 / observed 13 / userConfirmed 3 / inferred 3 / hypothesis 1——
 * 89% 的行同一个来源，剩下那 20 行里还包含了它们本来就是标准答案的那些；
 * type 有六种（fact 105 / decision 23 / goal 20 / preference 19 / project 14 / emotion 5）但和「这一问在问什么」无关，
 * 拿它排序等于替用户规定哪类经历更重要；supports 只有 1／2／3 三档，231 行里 200 行都是 1。
 * 三个信号的有效区分度都撑不起一个权重。
 * 至于 7.1 明说「只能影响检索排序」的那个访问频率：fixture 里没有这个字段，
 * 本地库的 `MemoryAccessTurn` 也是 0 行——**没有可测的数据就没有权重**，这一片不测它，
 * 也不假装接上了它。（这条红线的另一半——访问次数不得抬高可信度——由
 * tests/unit/cognitive-access.test.ts 守着，和这里无关。）
 *
 * 门禁在哪：任何把 salience 装进 `selectMemoryCandidates` 的改动都会改动「现状臂」的数字，
 * 于是 tests/unit/cognitive-eval-snapshot.test.ts 的逐字节比对立刻红——
 * 想要它变绿就得显式更新基线并说明为什么这版更好，这正是 7.4 末段要的流程。
 */

const K = MEMORY_READ_MAX_ITEMS;

const POOL = buildPool();
const PROBES: EvalProbe[] = allProbes().map((entry) => entry.probe);

/** 来源顺序：用户亲口说／确认过的最高，观察次之，推断与假设垫底。只用来排序，不参与乘法。 */
const ORIGIN_RANK: Record<MemoryOrigin, number> = {
  userConfirmed: 4,
  explicit: 3,
  observed: 2,
  inferred: 1,
  hypothesis: 0,
  retracted: 0
};

const COUNTS = new Map<string, EvidenceCounts>(
  allMemories().map((row) => [row.id, { supports: row.supports ?? 1, contradicts: row.contradicts ?? 0 }])
);

function usableRows(probe: EvalProbe): MemoryDto[] {
  return POOL.filter((memory) =>
    isMemoryUsable(memory, { policies: DEFAULT_MEMORY_POLICIES, chatId: probe.session, now: EVAL_NOW })
  );
}

/** 现状臂：线上读侧那一条路，一个字节都没改。 */
function currentSelect(probe: EvalProbe): MemoryDto[] {
  return selectMemoryCandidates({
    query: probe.query,
    rows: POOL,
    policies: DEFAULT_MEMORY_POLICIES,
    chatId: probe.session,
    now: EVAL_NOW
  });
}

function evidenceKey(memory: MemoryDto): number {
  const entry = COUNTS.get(memory.id) ?? { supports: 0, contradicts: 0 };
  return entry.supports - 2 * entry.contradicts;
}

/** 平手一律退回 recordedAt 倒序：这一片测的是显著性本身，不再发明一种平手规则。 */
function compareBy(key: (memory: MemoryDto) => number) {
  return (left: MemoryDto, right: MemoryDto): number => {
    if (key(left) !== key(right)) return key(right) - key(left);
    return right.recordedAt.localeCompare(left.recordedAt);
  };
}

/**
 * 变体一/二：只重排「一个关键词都没命中」的那批。
 * 有词可比的行仍按现状排在前面，所以它能改的只有兜底那几格。
 */
function remainderSelect(probe: EvalProbe, key: (memory: MemoryDto) => number): MemoryDto[] {
  const scored = scoreByKeyword(probe.query, usableRows(probe));
  const matched = scored.filter((entry) => entry.score > 0).map((entry) => entry.memory);
  const fallback = scored.filter((entry) => entry.score === 0).map((entry) => entry.memory).sort(compareBy(key));
  return [...matched, ...fallback].slice(0, K);
}

/**
 * 变体三/四：整池 RRF——关键词名次与显著性名次融合，和 5d 向量臂同一个公式（k = 60）。
 * 这一路会让一条高显著性、零词可比的行挤掉一条低相关但有命中的行，风险最大。
 */
function wholeRrfSelect(probe: EvalProbe, key: (memory: MemoryDto) => number): MemoryDto[] {
  const rows = usableRows(probe);
  const keyword = new Map<string, number>();
  scoreByKeyword(probe.query, rows).forEach((entry, index) => {
    if (entry.score > 0) keyword.set(entry.memory.id, index);
  });
  const salience = new Map<string, number>();
  [...rows].sort(compareBy(key)).forEach((memory, index) => salience.set(memory.id, index));

  const fused = rows
    .map((memory) => {
      let score = 0;
      const keywordRank = keyword.get(memory.id);
      const salienceRank = salience.get(memory.id);
      if (keywordRank !== undefined) score += 1 / (60 + keywordRank + 1);
      if (salienceRank !== undefined) score += 1 / (60 + salienceRank + 1);
      return { memory, score };
    })
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return right.memory.recordedAt.localeCompare(left.memory.recordedAt);
    });
  return fused.slice(0, K).map((entry) => entry.memory);
}

interface ProbeRow {
  id: string;
  gold: number;
  hits: number;
  precision: number;
  reciprocalRank: number;
  violations: number;
}

function rowFor(probe: EvalProbe, injected: MemoryDto[]): ProbeRow {
  const ids = injected.map((memory) => memory.id);
  const hits = probe.gold.filter((id) => ids.includes(id)).length;
  const firstHit = ids.findIndex((id) => probe.gold.includes(id));
  return {
    id: probe.id,
    gold: probe.gold.length,
    hits,
    precision: ids.length === 0 ? 0 : hits / ids.length,
    reciprocalRank: firstHit < 0 ? 0 : 1 / (firstHit + 1),
    violations: (probe.forbidden ?? []).filter((id) => ids.includes(id)).length
  };
}

function summary(rows: ProbeRow[]) {
  const withGold = rows.filter((row) => row.gold > 0);
  const mean = (pick: (row: ProbeRow) => number, source: ProbeRow[]) =>
    source.length === 0 ? 0 : source.reduce((sum, row) => sum + pick(row), 0) / source.length;
  const round = (value: number) => Number(value.toFixed(4));
  return {
    probes: rows.length,
    withGold: withGold.length,
    recallAt8: round(mean((row) => row.hits / row.gold, withGold)),
    precisionAt8: round(mean((row) => row.precision, rows)),
    mrr: round(mean((row) => row.reciprocalRank, rows)),
    forbidden: rows.reduce((sum, row) => sum + row.violations, 0),
    zeroHitProbes: withGold.filter((row) => row.hits === 0).length
  };
}

const TABLES = new Map<string, ProbeRow[]>([
  ['current', PROBES.map((probe) => rowFor(probe, currentSelect(probe)))],
  ['remainder-origin', PROBES.map((probe) => rowFor(probe, remainderSelect(probe, (m) => ORIGIN_RANK[m.origin])))],
  ['remainder-evidence', PROBES.map((probe) => rowFor(probe, remainderSelect(probe, evidenceKey)))],
  ['whole-rrf-origin', PROBES.map((probe) => rowFor(probe, wholeRrfSelect(probe, (m) => ORIGIN_RANK[m.origin])))],
  ['whole-rrf-evidence', PROBES.map((probe) => rowFor(probe, wholeRrfSelect(probe, evidenceKey)))]
]);

const totals = (name: string) => summary(TABLES.get(name)!);

/**
 * 禁项里此刻真的还在候选池中的那些。
 * 「违禁项注入 0 次」要是没有这个数陪着，就是空跑：大多数禁项（被取代的、已失效的）
 * 压根进不了池子，那是取数层的功劳，读侧排序无从泄漏。
 */
const FORBIDDEN_IDS = new Set(PROBES.flatMap((probe) => probe.forbidden ?? []));
const VISIBLE_FORBIDDEN = POOL.filter((memory) => FORBIDDEN_IDS.has(memory.id)).map((memory) => memory.id);

/** 掉命中的提问（相对现状）——判据二看的就是这一串，不是总分。 */
function lostHits(name: string): string[] {
  const base = TABLES.get('current')!;
  const other = TABLES.get(name)!;
  const out: string[] = [];
  for (let index = 0; index < base.length; index += 1) {
    if (other[index]!.hits < base[index]!.hits) out.push(base[index]!.id);
  }
  return out;
}

function gainedHits(name: string): string[] {
  const base = TABLES.get('current')!;
  const other = TABLES.get(name)!;
  const out: string[] = [];
  for (let index = 0; index < base.length; index += 1) {
    if (other[index]!.hits > base[index]!.hits) out.push(base[index]!.id);
  }
  return out;
}

describe('Salience Ranking 实测：四个变体都没够上接线', () => {
  it('违禁项那一栏不是空跑：有禁项此刻就在池子里，而五个臂一条都没注入', () => {
    // 这一栏只回答「读侧有没有把明令不该出现的那条端出去」。上面这个数要是 0，
    // 「违禁项 0 次」就只是取数层的功劳，跟排序一点关系都没有——那就不该记在读侧账上。
    expect(VISIBLE_FORBIDDEN.length).toBe(20);
    for (const [name, rows] of TABLES) {
      expect(rows.reduce((sum, row) => sum + row.violations, 0), name).toBe(0);
    }
  });

  it('现状那一栏的数字——这份对照的基准，改动读侧排序就要重新核对它', () => {
    expect(totals('current')).toEqual({
      probes: 116,
      withGold: 107,
      recallAt8: 0.7274,
      precisionAt8: 0.097,
      mrr: 0.5828,
      forbidden: 0,
      zeroHitProbes: 21
    });
  });

  it('兜底按来源重排：召回掉了，一处命中换不来任何一处增益', () => {
    expect(totals('remainder-origin').recallAt8).toBeLessThan(totals('current').recallAt8);
    expect(lostHits('remainder-origin')).toEqual(['s21-p1']);
    expect(gainedHits('remainder-origin')).toEqual([]);
  });

  it('兜底按证据条数重排：总分一位小数都不差，但它是两处换两处——判据二不接受', () => {
    expect(totals('remainder-evidence').recallAt8).toBe(totals('current').recallAt8);
    expect(lostHits('remainder-evidence')).toEqual(['s3-p1', 's21-p1']);
    expect(gainedHits('remainder-evidence')).toEqual(['s14-p1', 's25-p1']);
  });

  it('整池 RRF：显著性不带着「跟这一问有没有关系」的信息，把第一命中推后了', () => {
    expect(totals('whole-rrf-origin').mrr).toBeLessThan(0.4);
    expect(totals('whole-rrf-evidence').mrr).toBeLessThan(0.4);
    expect(totals('whole-rrf-evidence').recallAt8).toBeLessThan(totals('current').recallAt8);
  });

  it('捞不到的那 21 个提问是可达性问题：显著性排序最多再多救 2 个', () => {
    expect(totals('current').zeroHitProbes).toBe(21);
    expect(gainedHits('remainder-evidence').length).toBeLessThanOrEqual(2);
    expect(gainedHits('whole-rrf-evidence')).toEqual(expect.arrayContaining(['s14-p1', 's25-p1']));
  });

  it('这五个臂都在真跑：每个臂都至少有一轮命中过标准答案，对照不是空池子', () => {
    for (const [name, rows] of TABLES) {
      expect(rows.some((row) => row.hits > 0), name).toBe(true);
      expect(rows.every((row) => row.gold === 0 || row.hits <= row.gold), name).toBe(true);
    }
  });

  it('origin 这一路有东西可排，但只有 89% 一个取值', () => {
    expect(POOL.length).toBe(186);
    expect(POOL.filter((memory) => memory.origin === 'explicit').length).toBe(166);
    // 剩下 20 行分成四档（observed 13 / userConfirmed 3 / inferred 3 / hypothesis 1）。
    // 顺带把上面「兜底按来源重排」掉的那一处命中（s21-p1）的机制记清，别让它像个谜：
    // 它的标准答案 s21-m4 本身就是 explicit，没有被降权；它掉出前 8 是因为两条一个词都没匹配的
    // userConfirmed 行（s21-m7、s1-m7）插到兜底最前面，把原本排在第 5 个兜底位的它挤到第 7 位。
    // 这一挤就是显著性的全部问题：它只把「看着更可信」的行往前推，不管这一问有没有提到它。
    // （s3-p1 的 s3-m3 同一机制，只是它原本排在第 3 个兜底位、恰好还剩 3 个位，所以没掉。）
    expect(new Set(POOL.map((memory) => memory.origin)).size).toBe(5);
  });
});
