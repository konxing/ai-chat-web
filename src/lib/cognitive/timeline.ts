import type { MemoryDto, MemoryOrigin, MemoryRevisionAction, TimePrecision } from './memories';
import type { MemoryContext, MemoryType } from './policy';

/**
 * 认知时间线（任务书 Phase 4 的第一片：派生视图）。
 *
 * 这一片只做一件事——把**已经存在的记忆行和演化边**读成按时间排列的事件。
 * 事件抽取（4.1）、自然语言时间解析（4.2）、变化检测（4.3）都不在这里，
 * 因为时间线唯一能诚实成立的方式就是「每条事件都指得回一行真实记忆」。
 *
 * 三条从任务书直接落下来的形状：
 *
 * 一、**不许虚构经历**（4.4）。事件的每个字段都来自输入里的某一行，派生不新增事实：
 *    没有记忆就没有事件，空输入得到空时间线。任务书列的 12 类事件里，
 *    INTEREST_EMERGED、MILESTONE、CHALLENGE、GOAL_COMPLETED 这几类在现有列上没有来源，
 *    所以这一片一条也不生成——宁可时间线少几类，也不能凭语感造出用户没说过的经历。
 *
 * 二、**历史时间不许被记录时间冒充**（4.2）。用户今天提到一件去年发生的事，
 *    记忆行的 validFrom 存的是去年，recordedAt 存的是今天。时间线按 validFrom 排，
 *    只有精度为「未知」（也就是压根没时间信息）时才退回 recordedAt，
 *    并且把这个选择记在 timeSource 上给界面说出来——「按记录时间」和「按有效时间」不是一回事。
 *
 * 三、**精度封顶**：同精度打平时用记录时间定序，绝不显示比当初记下来的更精确的时刻。
 *
 * 折叠规则：一条记忆被更新过 N 次，演化边就把 N 个旧行串到当前版本上。
 * 时间线上它是**一个**事件（旧说法是新说法的历史，不是三段不同的经历），
 * historyCount 数的是真正折叠到的行数，与 version 分开给——行数不够时不虚报。
 */

/** 演化边里时间线用得上的四列。理由正文是密文，列表这一层不解密（点开详情再取）。 */
export interface TimelineEdge {
  memoryId: string;
  previousId: string | null;
  action: MemoryRevisionAction;
  createdAt: string;
}

export interface TimelineSource {
  memories: MemoryDto[];
  edges: TimelineEdge[];
}

export type TimelineTimeSource = 'validity' | 'recorded';

export interface TimelineEvent {
  memoryId: string;
  /** 事件类别 = 记忆类型。现有列只支撑这六类，见文件头第三条。 */
  category: MemoryType;
  content: string;
  context: MemoryContext;
  origin: MemoryOrigin;
  confirmedAt: string | null;
  precision: TimePrecision;
  occurredAt: string;
  timeSource: TimelineTimeSource;
  validFrom: string | null;
  validTo: string | null;
  version: number;
  historyCount: number;
  chatId: string | null;
  sourceMessageId: string | null;
  recordedAt: string;
}

export function deriveTimelineEvents({ memories, edges }: TimelineSource): TimelineEvent[] {
  const rows = new Map<string, MemoryDto>();
  for (const row of memories) {
    // 已撤回的说法不再是一次「经历」，它只解释旧版本为什么不用了。
    if (row.origin === 'retracted' || rows.has(row.id)) continue;
    rows.set(row.id, row);
  }

  // memoryId（新版本）→ previousId（它取代的那一版）。一条记忆只该有一个后继，
  // 出现多条时取第一条，后面的边不参与折叠，也不报错——那是数据异常，不是界面的事。
  const previousOf = new Map<string, string>();
  for (const edge of edges) {
    if (!edge.previousId || previousOf.has(edge.memoryId)) continue;
    previousOf.set(edge.memoryId, edge.previousId);
  }

  const events: TimelineEvent[] = [];
  const folded = new Set<string>();
  for (const head of [...rows.values()].filter((row) => row.supersededAt === null)) {
    const chain = new Set<string>([head.id]);
    let historyCount = 0;
    let cursor = previousOf.get(head.id);
    while (cursor && rows.has(cursor) && !chain.has(cursor)) {
      chain.add(cursor);
      folded.add(cursor);
      historyCount += 1;
      cursor = previousOf.get(cursor);
    }
    if (!folded.has(head.id)) events.push(toEvent(head, historyCount));
  }

  // 折叠不到的旧行（它的后继不在这一批里）单独成事件：
  // 把它接到一个不认识的新版本上，就是替用户编了一条他没见过的当前说法。
  for (const row of rows.values()) {
    if (row.supersededAt === null || folded.has(row.id)) continue;
    events.push(toEvent(row, 0));
  }

  return events.sort(compareEvents);
}

function toEvent(row: MemoryDto, historyCount: number): TimelineEvent {
  const useValidity = row.precision !== 'unknown' && row.validFrom !== null;
  return {
    memoryId: row.id,
    category: row.type,
    content: row.content,
    context: row.context,
    origin: row.origin,
    confirmedAt: row.confirmedAt,
    precision: row.precision,
    occurredAt: useValidity && row.validFrom ? row.validFrom : row.recordedAt,
    timeSource: useValidity ? 'validity' : 'recorded',
    validFrom: row.validFrom,
    validTo: row.validTo,
    version: row.version,
    historyCount,
    chatId: row.chatId,
    sourceMessageId: row.sourceMessageId,
    recordedAt: row.recordedAt
  };
}

/** 从早到晚。同时刻（同为「年」精度的两条最常见）用记录时间定序，再同则按 id 保证稳定。 */
function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
}
