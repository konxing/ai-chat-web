import type { MemoryDto } from '@/lib/cognitive/memories';
import type { ConfidenceSubject, EvidenceCounts } from '@/lib/cognitive/evidence';
import { assessWithCounts } from '@/lib/cognitive/evidence';
import { DEFAULT_MEMORY_POLICIES } from '@/lib/cognitive/policy';
import { isMemoryUsable } from '@/lib/cognitive/retention';
import {
  MEMORY_READ_MAX_ITEMS,
  MEMORY_RETRIEVAL_POOL,
  renderMemoryBlock,
  selectMemoryCandidates
} from '@/lib/cognitive/memory-module';
import { FILLER_SENTENCES } from './fillers';
import type { EvalMemory, EvalProbe } from './fixture-types';
import { allMemories, STORIES } from './fixtures/stories';

/**
 * Harness 的取样层：把 fixture 变成「线上那一刻 listMemories 会返回的东西」，
 * 然后交给生产的那两个纯函数去选择和渲染。
 *
 * 这里唯一一份复刻是 visibleAt。它抄的是 memories.ts:321 listMemories 的 where 条件
 * （supersededAt 为空、origin 不是 retracted、asOf 落在有效区间内）。
 * 必须说清楚它换不来什么：**它测不到 SQL，只测到「这些行不该出现在池子里」这件事在 fixture 上成立**。
 * 那条规则的真正的守门测试是 cognitive-memories.test.ts 里的 333 / 362 / 472 行三组用例，
 * 所以报告里凡是靠 visibleAt 的指标都标成「镜像规则」，只有靠 selectMemoryCandidates
 * 和 renderMemoryBlock 的才算实测。
 */

/** 评测时刻：所有 day 都相对它换算，换成绝对日期会让整个池子过段时间集体过期。 */
export const EVAL_NOW = new Date('2026-11-03T00:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(day: number): string {
  return new Date(EVAL_NOW.getTime() + day * DAY_MS).toISOString();
}

/** 这条行此刻还在「当前有效」里吗——镜像 listMemories 的 where，见文件头。 */
function visibleAt(row: EvalMemory, asOf: Date): boolean {
  if (row.supersededDay !== undefined && new Date(iso(row.supersededDay)) <= asOf) return false;
  if (row.origin === 'retracted') return false;
  if (row.validToDay !== undefined && new Date(iso(row.validToDay)) < asOf) return false;
  if (row.validFromDay !== undefined && new Date(iso(row.validFromDay)) > asOf) return false;
  return true;
}

function toDto(row: EvalMemory): MemoryDto {
  return {
    id: row.id,
    chatId: row.session,
    sourceMessageId: `${row.session}-msg`,
    type: row.type,
    context: row.context,
    origin: row.origin,
    content: row.content,
    confirmedAt: iso(row.day),
    precision: 'unknown',
    validFrom: row.validFromDay === undefined ? null : iso(row.validFromDay),
    validTo: row.validToDay === undefined ? null : iso(row.validToDay),
    version: row.version ?? 1,
    supersededAt: row.supersededDay === undefined ? null : iso(row.supersededDay),
    recordedAt: iso(row.day)
  };
}

function evidenceCounts(row: EvalMemory): EvidenceCounts {
  return { supports: row.supports ?? 1, contradicts: row.contradicts ?? 0 };
}

/**
 * 候选池：全部故事共用一个池子——线上一个用户面对的就是「他的所有记忆」，不是按主题切开的。
 *
 * 上限 MEMORY_RETRIEVAL_POOL 是照抄 readMemory 传给 listMemories 的那个 take：
 * 线上 SQL 只给最近 200 行，池子超过这个数以后，多出来的行根本到不了召回那一步。
 * 不镜像这一条，铺到 30 个故事时就会测一个线上不存在的池子。
 */
export function buildPool(): MemoryDto[] {
  return allMemories()
    .filter((row) => visibleAt(row, EVAL_NOW))
    .map(toDto)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, MEMORY_RETRIEVAL_POOL);
}

function countMap(rows: readonly EvalMemory[]): Map<string, EvidenceCounts> {
  return new Map(rows.map((row) => [row.id, evidenceCounts(row)]));
}

export interface ProbeResult {
  probe: EvalProbe;
  arm: 'A2' | 'current';
  /** 这一轮实际注入的记忆 id，按注入顺序。 */
  injected: string[];
  /** 送进模型的那段文本，用于算字符数和检查低可信标注。 */
  text: string;
  /** 被选中的行各自的档位，冲突指标要看有没有以确定性口气进提示词。 */
  bands: Record<string, 'low' | 'medium' | 'high'>;
}

/**
 * 两个对照臂共用同一个渲染器，差异只在「怎么选这 8 条」：
 * A2 是改造前——按 recordedAt 取最近 K 条，不过保留期；
 * current 是线上——保留期过滤 + 关键词召回。
 * 只换一个变量，数字动了才说得出是谁干的。
 */
export function runProbe(
  pool: readonly MemoryDto[],
  probe: EvalProbe,
  arm: 'A2' | 'current'
): ProbeResult {
  const counts = countMap(allMemories());
  let selected: MemoryDto[];
  if (arm === 'A2') {
    selected = pool.slice(0, MEMORY_READ_MAX_ITEMS);
  } else {
    selected = selectMemoryCandidates({
      query: probe.query,
      rows: pool,
      policies: DEFAULT_MEMORY_POLICIES,
      chatId: probe.session,
      now: EVAL_NOW
    });
  }
  const confidence = assessWithCounts(selected as ConfidenceSubject[], counts, EVAL_NOW);
  const blocks = renderMemoryBlock(selected, confidence);
  const text = blocks.length === 0 ? '' : blocks[0]!.text;
  const bands = Object.fromEntries(
    selected.map((memory) => [memory.id, confidence.get(memory.id)?.band ?? 'low'])
  );
  return { probe, arm, injected: selected.map((memory) => memory.id), text, bands };
}

/** 延迟要在 200 行池子上测：小池子里「整个池子捞回来解密再比」这个代价根本显不出来。 */
export function paddedPool(pool: readonly MemoryDto[], size = 200): MemoryDto[] {
  const padded = [...pool];
  let index = 0;
  while (padded.length < size) {
    const content = FILLER_SENTENCES[index % FILLER_SENTENCES.length]!;
    padded.push({
      ...padded[0]!,
      id: `pad-${index}`,
      content: `${content}（第 ${index} 条噪声）`,
      chatId: `pad-session-${index}`,
      recordedAt: new Date(EVAL_NOW.getTime() - (index + 1) * DAY_MS).toISOString()
    });
    index += 1;
  }
  return padded;
}

export interface FixtureProblem {
  where: string;
  message: string;
}

/**
 * fixture 自查：把「标注得自己说得过去」变成机器断言。
 * 正文逐字出自声明的会话、重复陈述次数不许超过出现次数、反对证据必须写理由、
 * 标准答案必须真的可达——
 * 这几条只要断一条，整份报告的金标准就不可信，所以先跑它再跑指标。
 */
export function selfCheck(): FixtureProblem[] {
  const problems: FixtureProblem[] = [];
  const seen = new Set<string>();
  // 标准答案得先真的在候选池里，否则 Recall 测的是「捞不到一条本来就不存在的行」。
  const pool = new Set(buildPool().map((memory) => memory.id));
  const rows = new Map(allMemories().map((row) => [row.id, row]));

  for (const story of STORIES) {
    if (story.sessions.length < 6 || story.sessions.length > 10) {
      problems.push({ where: story.id, message: `会话数 ${story.sessions.length}，7.1 要求 6~10 个` });
    }
    const sessionIds = new Set(story.sessions.map((session) => session.id));

    for (const row of story.memories) {
      if (seen.has(row.id)) problems.push({ where: row.id, message: '记忆 id 重复' });
      seen.add(row.id);
      if (!sessionIds.has(row.session)) {
        problems.push({ where: row.id, message: `出处会话 ${row.session} 不存在` });
        continue;
      }
      const home = story.sessions.find((session) => session.id === row.session)!;
      if (!home.lines.includes(row.content)) {
        problems.push({ where: row.id, message: `正文不是 ${home.id} 里的原话：${row.content}` });
      }
      const appearances = story.sessions.filter((session) => session.lines.includes(row.content)).length;
      const claimed = row.supports ?? 1;
      if (claimed > appearances) {
        problems.push({
          where: row.id,
          message: `声明 ${claimed} 次独立陈述，原话只出现在 ${appearances} 个会话里`
        });
      }
      if ((row.contradicts ?? 0) > 0 && !row.note) {
        problems.push({ where: row.id, message: '有反对证据却没写理由，标注无法复核' });
      }
    }

    for (const probe of story.probes) {
      if (!sessionIds.has(probe.session)) {
        problems.push({ where: probe.id, message: `提问会话 ${probe.session} 不存在` });
      }
      if (!probe.why) problems.push({ where: probe.id, message: '标准答案没写依据' });
      for (const id of [...probe.gold, ...(probe.forbidden ?? [])]) {
        if (!seen.has(id)) problems.push({ where: probe.id, message: `引用的记忆 ${id} 不存在` });
      }
      for (const id of probe.expectLowMarked ?? []) {
        if (!probe.gold.includes(id)) {
          problems.push({ where: probe.id, message: `要求标注 ${id} 但它不在标准答案里` });
        }
      }
      for (const id of probe.gold) {
        if ((probe.forbidden ?? []).includes(id)) {
          problems.push({ where: probe.id, message: `${id} 既是标准答案又是禁项，这条标注自相矛盾` });
          continue;
        }
        if (!pool.has(id)) {
          problems.push({
            where: probe.id,
            message: `标准答案 ${id} 压根不在候选池里（时效挡掉或超出 ${MEMORY_RETRIEVAL_POOL} 行上限），这条提问测不出召回`
          });
          continue;
        }
        const row = rows.get(id)!;
        if (
          !isMemoryUsable(
            { context: row.context, chatId: row.session, recordedAt: iso(row.day) },
            { policies: DEFAULT_MEMORY_POLICIES, chatId: probe.session, now: EVAL_NOW }
          )
        ) {
          problems.push({
            where: probe.id,
            message: `标准答案 ${id} 被保留期挡在 ${probe.session} 之外（${row.context}），换会话就召不回来的东西不该当成本轮该答的`
          });
        }
      }
    }
  }
  return problems;
}
