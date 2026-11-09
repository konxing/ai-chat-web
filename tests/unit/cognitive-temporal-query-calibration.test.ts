import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectMemoryCandidates } from '@/lib/cognitive/memory-module';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import { isMemoryUsable } from '@/lib/cognitive/retention';
import { resolveTemporalFrame, type TemporalFrame } from '@/lib/cognitive/temporal';
import type { MemoryDto } from '@/lib/cognitive/memories';
import { allMemories, allProbes } from '../../scripts/cognitive-eval/fixtures/stories';
import type { EvalProbe } from '../../scripts/cognitive-eval/fixture-types';
import { buildPool, EVAL_NOW } from '../../scripts/cognitive-eval/harness';

/**
 * Temporal Filtering 的实测（任务书 3.4 六项召回能力里的第四项）。
 *
 * 结论先说：**问侧和答侧都没有料，这一项在现有语料上量不出来，所以读侧不接线。**
 * 但这一片和 Salience 那一片不一样——那一片是「测出来了，是零收益」，这一片是
 * 「这台仪器在这副语料上没有可测的对象」。两件事必须分开写，否则后一个人会以为
 * 时间过滤已经被证明没用，而它只是从来没被称过。
 *
 * 为什么它注定称不出来，两侧各一条：
 *
 * 一、**问侧 116 个提问里只有 1 个解析得出时间框架**（s12-p3「这个月的存款进度我在跟吗」
 *    → `month` / 2026-11-01）。另有 4 条被一张故意放宽的探测表捞出来「像有时间字样」，
 *    逐条看过：3 条压根不该按时间过滤（「日语角是星期几」「远程那天我几点在线」是在**问**时间、
 *    不是按时间限定；「睡眠的事我之前提过吗」的「之前」是一个没有边界的副词），
 *    第 4 条（「我的情绪触发点是什么」）是探测表自己误报了「点」字——那是仪器的假阳性，
 *    不是语料的漏项。
 *
 * 二、**答侧一个坐标都没有**：全部 231 行 fixture 里只有 3 行写了 `validFromDay`
 *    （s4-m6 +20、s14-m7 +3、s21-m5 +40 天），三条全是「下个月开始」「下周一跟主管提」
 *    这种还没开始的计划；而 harness 的可见性镜像（`harness.ts:42`）正好把还没生效的行挡在池子外，
 *    所以此刻可见的 186 行里 `validFrom` 非空的有 **0 行**，`precision` 全是 `unknown`
 *    （那个字段是镜像写死的：`harness.ts:56`——fixture 行没走过写侧解析，就没有精度可言）。
 *
 * 两侧合起来的后果：一个诚实的时间过滤器（拿不准就不丢，见下面第六条用例）
 * 在这副语料上**只能**得到「一行都没丢」。于是过滤臂和现状臂逐键相同——
 * 这个相等是结构保证的，不是经验发现，它不构成「时间过滤无害」的证据。
 *
 * 还有一条容易被这一片顺手做坏的事，写在最前面：**行侧那一半早就在跑了**。
 * 「这条记忆此刻还算不算数」由 `listMemories` 的 SQL 用 `asOf` 判（`memories.ts:373-376`，
 * 静态断言见最后一条用例）。s21-p1 靠的就是它：旧日期 `s21-m3`（`validToDay: -3`，报名已取消）
 * 进不了池子，标准答案 `s21-m4`「改到明年三月」能——而后者能见恰恰是因为它**没有** `validFrom`，
 * 「明年三月」从未被写成坐标。这一片不碰这一半，也不许把它实现第二遍。
 * 3.4 这一项剩下的只有**问侧**那一半：用户把时间说在问题里时，把候选限定在那一段时间，这片测的是后者。
 *
 * 门禁在哪：这一片不改 `src/`，所以 `cognitive-eval-snapshot` 的逐字节比对必须一直是绿的；
 * 谁把过滤装进 `selectMemoryCandidates`，上面那两个「0」和「1」就得重测——
 * 而真正该做的顺序是：先让片W 的扩语料把答侧的 `validFrom` / `precision` 铺出来，
 * 再谈接线。**给这副语料接一个恒不生效的过滤器，比不接更像是骗人。**
 */

const POOL = buildPool();
const PROBES: EvalProbe[] = allProbes().map((entry) => entry.probe);

/**
 * 一个刻意放宽的「这话里像有时间字样」探测表，只用来数词表漏了多少，不参与任何结论。
 * 宽到把「点」「之后」都算进去是有意的：宁可多捞几条再逐条排除，也不要漏掉一条却说「问侧没料」。
 */
const WIDE_TIME_RE =
  /(\d{4}|\d{1,2}月|\d{1,2}日|\d{1,2}号|周[一二三四五六日天]|星期|明年|今年|去年|前年|上半年|下半年|季度|下周|本周|上周|明天|今天|昨天|前天|后天|这个月|本月|上个月|这周|那时|当时|以前|之前|之后|以来|点|年份|月份|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月|2025|2026|2027)/;

interface TimedRow {
  id: string;
  precision: string;
  validFrom: string | null;
}

/** 框架的窗口右端由精度决定：说「2025 年」就是一整年，说「昨天」就是一天。 */
function windowOf(frame: TemporalFrame): [number, number] {
  const from = frame.validFrom.getTime();
  const year = frame.validFrom.getUTCFullYear();
  const month = frame.validFrom.getUTCMonth();
  const day = frame.validFrom.getUTCDate();
  const to =
    frame.precision === 'year'
      ? Date.UTC(year + 1, 0, 1)
      : frame.precision === 'month'
        ? Date.UTC(year, month + 1, 1)
        : Date.UTC(year, month, day + 1);
  return [from, to];
}

/**
 * 这一条是整个设计的落点：**说不出这条从哪天开始，就留着他。**
 * 丢行是不可逆的——用户问「去年」而系统把一个没写日期的正确答案划掉，界面上什么都不会说。
 * 所以这里只在「行自己有坐标、且坐标明确落在窗口外」时才丢。
 */
function inWindow(row: TimedRow, [from, to]: [number, number]): boolean {
  if (row.precision === 'unknown' || row.validFrom === null) return true;
  const point = new Date(row.validFrom).getTime();
  return point >= from && point < to;
}

function usableRows(probe: EvalProbe): MemoryDto[] {
  return POOL.filter((memory) =>
    isMemoryUsable(memory, { policies: DEFAULT_MEMORY_POLICIES, chatId: probe.session, now: EVAL_NOW })
  );
}

function currentSelect(probe: EvalProbe): MemoryDto[] {
  return selectMemoryCandidates({
    query: probe.query,
    rows: POOL,
    policies: DEFAULT_MEMORY_POLICIES,
    chatId: probe.session,
    now: EVAL_NOW
  });
}

/** 过滤臂：先按问侧框架筛池子，再走线上那一个选择函数（过滤不改排序，也不改渲染）。 */
function filteredSelect(probe: EvalProbe): { rows: MemoryDto[]; dropped: number; applied: boolean } {
  const rows = usableRows(probe);
  const frame = resolveTemporalFrame(probe.query, EVAL_NOW);
  if (frame === null) return { rows: currentSelect(probe), dropped: 0, applied: false };
  const kept = rows.filter((memory) => inWindow(memory, windowOf(frame)));
  return {
    dropped: rows.length - kept.length,
    applied: true,
    rows: selectMemoryCandidates({
      query: probe.query,
      rows: kept,
      policies: DEFAULT_MEMORY_POLICIES,
      chatId: probe.session,
      now: EVAL_NOW
    })
  };
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
  const firstHit = ids.findIndex((id) => probe.gold.includes(id));
  return {
    id: probe.id,
    gold: probe.gold.length,
    hits: probe.gold.filter((id) => ids.includes(id)).length,
    precision: ids.length === 0 ? 0 : probe.gold.filter((id) => ids.includes(id)).length / ids.length,
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

const CURRENT = PROBES.map((probe) => rowFor(probe, currentSelect(probe)));
const ARMS = PROBES.map((probe) => filteredSelect(probe));
const FILTERED = PROBES.map((probe, index) => rowFor(probe, ARMS[index]!.rows));
const DROPPED_TOTAL = ARMS.reduce((sum, arm) => sum + arm.dropped, 0);
/** 过滤真的开火过几次——没有这一栏，「两臂相同」可以只是「过滤压根没跑」。 */
const FILTER_APPLIED = ARMS.filter((arm) => arm.applied).length;

const PARSED = PROBES.filter((probe) => resolveTemporalFrame(probe.query, EVAL_NOW) !== null);
const WIDE_ONLY = PROBES.filter(
  (probe) => resolveTemporalFrame(probe.query, EVAL_NOW) === null && WIDE_TIME_RE.test(probe.query)
);

const TIMED_FIXTURE_ROWS = allMemories().filter((row) => row.validFromDay !== undefined);

describe('Temporal Filtering 实测：问侧 1 条、答侧 0 行，这一项量不出来', () => {
  it('问侧：116 个提问里只有 1 个解析得出时间框架', () => {
    expect(PROBES.length).toBe(116);
    expect(PARSED.map((probe) => probe.id)).toEqual(['s12-p3']);
    const frame = resolveTemporalFrame('这个月的存款进度我在跟吗', EVAL_NOW);
    expect(frame).not.toBeNull();
    expect(frame!.precision).toBe('month');
    expect(frame!.validFrom.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('宽表捞出的 4 条里，3 条本来就不该按时间过滤，1 条是仪器自己误报', () => {
    expect(WIDE_ONLY.map((probe) => probe.id)).toEqual(['s7-p4', 's10-p2', 's16-p4', 's26-p1']);
    // 前两条是在「问」时间而不是按时间限定：一个问星期几、一个问那天几点。
    // 按「那」字去圈窗口等于替用户猜哪天。
    expect(WIDE_ONLY.filter((probe) => /星期|那[天时]/.test(probe.query)).map((probe) => probe.id)).toEqual([
      's10-p2',
      's16-p4'
    ]);
    // 「我之前提过吗」的「之前」没有边界，解析不出来是对的（temporal.ts 头一条形状：拿不准就 null）。
    expect(resolveTemporalFrame('睡眠的事我之前提过吗', EVAL_NOW)).toBeNull();
    // 「情绪触发点」里一个时间字样都没有——这一条是宽表的假阳性，记在这里免得被读成语料漏项。
    expect(WIDE_TIME_RE.test('我的情绪触发点是什么')).toBe(true);
  });

  it('答侧：3 行带开始时间的全是还没开始的计划，所以可见池一行都没有', () => {
    expect(TIMED_FIXTURE_ROWS.map((row) => row.id)).toEqual(['s4-m6', 's14-m7', 's21-m5']);
    expect(TIMED_FIXTURE_ROWS.every((row) => (row.validFromDay ?? 0) > 0)).toBe(true);
    // 还没生效 ⇒ 镜像判不可见 ⇒ 池子里一个 validFrom 都摸不到。
    const poolIds = new Set(POOL.map((memory) => memory.id));
    for (const row of TIMED_FIXTURE_ROWS) expect(poolIds.has(row.id), row.id).toBe(false);
    expect(POOL.length).toBe(186);
    expect(POOL.filter((memory) => memory.validFrom !== null).length).toBe(0);
    expect(new Set(POOL.map((memory) => memory.precision))).toEqual(new Set(['unknown']));
  });

  it('过滤臂和现状臂逐键相同——而这是结构保证，不是「过滤没坏处」的证据', () => {
    // 这一条必须配着 FILTER_APPLIED 读。探针 P4 实测：把过滤整段跳过，这一条照样全绿——
    // 也就是说「两臂相同」本身什么都不能证明，是这个 1 证明过滤确实在那个唯一的提问上跑了。
    expect(FILTER_APPLIED).toBe(1);
    expect(DROPPED_TOTAL).toBe(0);
    expect(summary(FILTERED)).toEqual(summary(CURRENT));
    expect(summary(CURRENT)).toEqual({
      probes: 116,
      withGold: 107,
      recallAt8: 0.7274,
      precisionAt8: 0.097,
      mrr: 0.5871,
      forbidden: 0,
      zeroHitProbes: 21
    });
  });

  it('这台仪器有牙：窗口是左闭右开，年 / 月 / 日三种精度各切一遍', () => {
    const row = (id: string, validFrom: string | null): TimedRow => ({ id, precision: 'day', validFrom });
    const edges = (frame: TemporalFrame, stamps: string[]) =>
      stamps.map((stamp) => inWindow(row('x', stamp), windowOf(frame)));

    // 2025 年：跨年界的两端都不算，今年 12 月 31 日算。
    expect(
      edges({ precision: 'year', validFrom: new Date('2025-01-01T00:00:00.000Z') }, [
        '2024-12-31T23:59:59.000Z',
        '2025-01-01T00:00:00.000Z',
        '2025-12-31T23:59:59.000Z',
        '2026-01-01T00:00:00.000Z'
      ])
    ).toEqual([false, true, true, false]);

    // 2026 年 11 月：这个月说「这个月」，边界正好压在评测时刻那天之前。
    expect(
      edges({ precision: 'month', validFrom: new Date('2026-11-01T00:00:00.000Z') }, [
        '2026-10-31T23:59:59.000Z',
        '2026-11-01T00:00:00.000Z',
        '2026-11-15T08:00:00.000Z',
        '2026-12-01T00:00:00.000Z'
      ])
    ).toEqual([false, true, true, false]);

    // 2026-11-02 那一天（EVAL_NOW 的前一天，也就是「昨天」）：一天就是一天，不多不少。
    expect(
      edges({ precision: 'day', validFrom: new Date('2026-11-02T00:00:00.000Z') }, [
        '2026-11-01T23:59:59.000Z',
        '2026-11-02T00:00:00.000Z',
        '2026-11-02T23:59:59.000Z',
        '2026-11-03T00:00:00.000Z'
      ])
    ).toEqual([false, true, true, false]);
  });

  it('拿不准就不丢：precision unknown 或没有 validFrom 的行，窗口再窄也留着', () => {
    const window = windowOf({ precision: 'day', validFrom: new Date('2026-11-02T00:00:00.000Z') });
    expect(inWindow({ id: 'no-date', precision: 'day', validFrom: null }, window)).toBe(true);
    expect(inWindow({ id: 'unknown', precision: 'unknown', validFrom: '2019-05-05T00:00:00.000Z' }, window)).toBe(true);
    // 上面那条就是这副语料的全部形状：2019 年的一句话，因为没写日期，问「昨天」照样带着它。
    // 这不是过滤器的漏洞，是它唯一的诚实形态——丢了它，界面上连一句「我按时间筛过」都说不出口。
    expect(POOL.every((memory) => inWindow(memory, window))).toBe(true);
  });

  it('行侧那一半早就在跑：SQL 里两道 asOf 条件，这一片不重复实现', () => {
    const sql = readFileSync(path.resolve(process.cwd(), 'src/lib/cognitive/memories.ts'), 'utf8');
    expect(sql).toContain('{ validTo: null }, { validTo: { gte: filters.asOf } }');
    expect(sql).toContain('{ validFrom: null }, { validFrom: { lte: filters.asOf } }');
  });
});
