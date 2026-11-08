import { prisma } from '@/lib/prisma';
import { getRawSystemSetting } from '@/lib/config';
import { log } from '@/lib/logger';
import { streamChatCompletion } from '@/lib/ai';
import {
  archiveMemory,
  createMemory,
  listMemories,
  reviseMemory,
  type MemoryDto
} from './memories';
import { getCognitivePreferences } from './preferences';
import { AI_EXTRACTION_TIMEOUT_MS, resolveMemoryExtractionProvider } from './memory-extractor-ai';
import type { MemoryContext, MemoryType } from './policy';

/**
 * 会话结束总结（session summary）。
 *
 * 一轮一轮抽出来的记忆天然是碎片：一句话一条、语音转写甚至半句一条。一场对话结束后，
 * 这些碎片留在库里，召回时它们互相挤占名额，模型也会被碎片带偏。这一层做两件事：
 * 一、把这场对话的碎片交给审核模型收拢成几条要点（能分开就分开，只合并同义重复，保留清单与数字）；
 * 二、同时让它拿这些要点比对**其它已存记忆**：说的是同一件事就填 `duplicateOf`（重复，不再落一条），
 *    是对旧说法的更新/改口就填 `updates`（走演化取代旧行）。
 *
 * 落库形状（为什么这样定）：
 * - 要点行 `chatId = null`、`origin = inferred`：正文是系统归纳的、不是用户原话，来源要如实标成推断；
 *   置空 chatId 还有一个硬作用——这一场的碎片归档后，该会话不再满足「≥3 条活跃碎片」的触发条件，
 *   同一场对话不会被下一轮扫描反复总结。
 * - 被合并的碎片走**可逆归档**（不删），并作为「同主题」边挂到新要点上，保住出处。
 * - 幂等：重复跑时碎片已归档，触发条件不成立；即便跑两次，内容去重也会挡住重复落库。
 *
 * 只在后台扫描里跑（task-worker 每轮对活跃用户触发一次），一轮最多总结一场对话，不占对话关键路径。
 * 开关：后台「系统配置 → 记忆审核」的 `cognitiveSessionSummaryEnabled`（老库回落 env
 * `COGNITIVE_SESSION_SUMMARY=1`）。关着时一次模型都不调。
 *
 * 测试：tests/unit/cognitive-session-summary.test.ts
 */

/** 会话「结束了」的门槛：最后一次活动距今至少这么久，才当作一场对话已经讲完。 */
export const SESSION_SUMMARY_IDLE_MINUTES = 20;
/** 至少要这么多条活跃碎片才有总结的意义；只有一两条时总结等于原地搬运。 */
export const SESSION_SUMMARY_MIN_FRAGMENTS = 3;
/** 一次最多读多少条碎片（按最近记录优先）。 */
export const SESSION_SUMMARY_MAX_FRAGMENTS = 10;
/** 比对时给模型看多少条其它记忆。 */
export const SESSION_SUMMARY_MAX_OTHERS = 20;
/** 一次最多产出几条要点；能分开就不许硬合并。 */
export const SESSION_SUMMARY_MAX_POINTS = 6;
/** 单条要点的长度上限：要点要比碎片短，不能把一段长文原样搬过来。 */
export const SESSION_SUMMARY_MAX_TEXT = 500;
/** 单条要点最短长度。 */
export const SESSION_SUMMARY_MIN_TEXT = 4;

export const SESSION_SUMMARY_PROMPT = [
  '你是会话记忆总结员。给你这次对话里产生的零散记忆片段（带 id），以及用户其它已存的记忆（带 id）。',
  '任务：把这些碎片整理成少数几条要点，交给长期记忆。',
  '规则：',
  '1. 只有同义重复才合并；能分开的要点要分开。保留原话里的清单、数字、专有名词，不许改写意思，不许编造。',
  '2. 每条要点用 merges 列出它合并/归纳了哪些**片段** id（至少一条，只能取片段列表里的 id）。',
  '3. 如果某条要点与「其它已存记忆」里某条说的是同一件事（重复），把那条 id 填进 duplicateOf——不要再记一条重复的。',
  '4. 如果某条要点是对「其它已存记忆」某条说的更新/改口（同一个主题、说法有差别），把那条 id 填进 updates。',
  '5. type 只能是 fact/preference/goal/project/decision/emotion 之一。',
  '只输出一个 JSON 数组，元素形如 {"text":"要点","type":"goal","merges":["id1","id2"]}（duplicateOf / updates 可省略）；没有要点就输出 []。不要输出任何解释。'
].join('\n');

export async function sessionSummaryEnabled(): Promise<boolean> {
  const raw = await getRawSystemSetting('cognitiveSessionSummaryEnabled').catch(() => null);
  if (raw !== null) return raw === true || raw === 'true';
  return process.env.COGNITIVE_SESSION_SUMMARY === '1';
}

const ALLOWED_TYPES: readonly MemoryType[] = ['fact', 'preference', 'goal', 'project', 'decision', 'emotion'];

export interface SummaryPoint {
  text: string;
  type: MemoryType;
  /** 这条要点合并了哪些碎片。整合后这些碎片会被归档。 */
  merges: string[];
  /** 与其它已存记忆重复时指向那条：重复，不再落库。 */
  duplicateOf?: string;
  /** 是对其它已存记忆的更新/改口时指向那条：走演化取代。 */
  updates?: string;
}

export interface SummaryPlan {
  /** 要新建（或演化）的要点。 */
  create: SummaryPoint[];
  /** 判定为重复、不落库的要点（归一化正文用于日志计数，不含正文）。 */
  duplicates: number;
  /** 被合并、应当归档的碎片 id（去重后）。 */
  archive: string[];
  /** 解析出来但不可用的条数（非法 type、空 merges、编造 id…）。 */
  rejected: number;
}

/**
 * 解析模型输出。防御性策略与记忆审核一致：抓第一个数组、逐条校验。
 * `merges` 只接受片段集合里的 id；`duplicateOf` / `updates` 只接受其它记忆集合里的 id——
 * 编出来的 id 一律丢弃（指错一条会把别的记忆归档或取代掉，比少并一条贵得多）。
 * `merges` 过滤后为空 = 这条要点没有出处，整条丢弃。
 */
export function parseSummaryPoints(
  raw: string,
  allowed: { fragmentIds: ReadonlySet<string>; otherIds: ReadonlySet<string> }
): SummaryPoint[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const points: SummaryPoint[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const text = (item as { text?: unknown }).text;
    const type = (item as { type?: unknown }).type;
    const merges = (item as { merges?: unknown }).merges;
    if (typeof text !== 'string' || typeof type !== 'string') continue;
    if (!ALLOWED_TYPES.includes(type as MemoryType)) continue;
    const trimmed = text.trim();
    if (trimmed.length < SESSION_SUMMARY_MIN_TEXT || trimmed.length > SESSION_SUMMARY_MAX_TEXT) continue;
    if (!Array.isArray(merges)) continue;
    const validMerges = merges.filter((id): id is string => typeof id === 'string' && allowed.fragmentIds.has(id));
    if (validMerges.length === 0) continue;
    const key = trimmed.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const point: SummaryPoint = {
      text: trimmed,
      type: type as MemoryType,
      merges: [...new Set(validMerges)]
    };
    const duplicateOf = (item as { duplicateOf?: unknown }).duplicateOf;
    if (typeof duplicateOf === 'string' && allowed.otherIds.has(duplicateOf)) point.duplicateOf = duplicateOf;
    const updates = (item as { updates?: unknown }).updates;
    if (typeof updates === 'string' && allowed.otherIds.has(updates)) point.updates = updates;
    // 同时标了重复和更新时按重复处理：重复不落库，就不存在"取代"这回事。
    if (point.duplicateOf) delete point.updates;
    points.push(point);
  }
  return points;
}

/**
 * 把解析结果摊成执行计划。纯函数：条目上限、重复与更新的分流、归档清单都在这里定，
 * 数据库只按计划执行。重复的不进 create，也不归档它的碎片（碎片是那条已有记忆的旁证，留着）。
 */
export function planSummary(points: readonly SummaryPoint[]): SummaryPlan {
  const create: SummaryPoint[] = [];
  let duplicates = 0;
  let rejected = 0;
  const archive = new Set<string>();
  for (const point of points) {
    if (create.length >= SESSION_SUMMARY_MAX_POINTS) {
      rejected += 1;
      continue;
    }
    if (point.duplicateOf) {
      duplicates += 1;
      continue;
    }
    create.push(point);
    for (const id of point.merges) archive.add(id);
  }
  return { create, duplicates, archive: [...archive], rejected };
}

export interface SessionSummaryOutcome {
  created: number;
  updated: number;
  duplicates: number;
  archived: number;
  rejected: number;
}

/**
 * 总结一场对话。`fragments` 是这场对话的活跃碎片，`others` 是其它活跃记忆（用于查重与查差别）。
 * 返回 null 表示这次没得到可用结论（模型失败/解析失败/没有可落库的要点）——调用方什么都不改。
 */
export async function summarizeChatMemories(
  userId: string,
  fragments: readonly MemoryDto[],
  others: readonly MemoryDto[]
): Promise<SessionSummaryOutcome | null> {
  if (fragments.length < SESSION_SUMMARY_MIN_FRAGMENTS) return null;
  const provider = await resolveMemoryExtractionProvider(userId);

  const userPrompt = [
    '这次对话产生的碎片：',
    JSON.stringify(
      fragments.slice(0, SESSION_SUMMARY_MAX_FRAGMENTS).map((memory) => ({ id: memory.id, type: memory.type, text: memory.content }))
    ),
    '',
    '其它已存记忆（查重与查差别用；不要动它们）：',
    JSON.stringify(
      others
        .slice(0, SESSION_SUMMARY_MAX_OTHERS)
        .map((memory) => ({ id: memory.id, type: memory.type, text: memory.content.slice(0, 120) }))
    )
  ].join('\n');

  let raw = '';
  try {
    for await (const event of streamChatCompletion({
      provider,
      messages: [
        { role: 'system', content: SESSION_SUMMARY_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      timeoutMs: AI_EXTRACTION_TIMEOUT_MS
    })) {
      if (event.type === 'delta' && event.text) raw += event.text;
    }
  } catch {
    log.warn('cognitive.session_summary_failed', { userId, reason: 'model_error' });
    return null;
  }

  const points = parseSummaryPoints(raw, {
    fragmentIds: new Set(fragments.map((memory) => memory.id)),
    otherIds: new Set(others.map((memory) => memory.id))
  });
  if (points === null) {
    log.warn('cognitive.session_summary_failed', { userId, reason: 'parse_failed' });
    return null;
  }
  const plan = planSummary(points);
  if (plan.create.length === 0 && plan.duplicates === 0) {
    log.info('cognitive.session_summary_nothing', { userId, rejected: plan.rejected });
    return null;
  }

  const fragmentById = new Map(fragments.map((memory) => [memory.id, memory]));
  const related = plan.archive
    .map((id) => fragmentById.get(id))
    .filter((memory): memory is MemoryDto => Boolean(memory))
    .map((memory) => ({ id: memory.id, content: memory.content, context: memory.context }));

  let created = 0;
  let updated = 0;
  for (const point of plan.create) {
    if (point.updates) {
      try {
        await reviseMemory({
          previousId: point.updates,
          userId,
          content: point.text,
          type: point.type,
          origin: 'inferred',
          // 会话总结带进出处：这次演化不是用户当场改口，而是系统归纳出「说法有差别」。
          chatId: null,
          sourceMessageId: null,
          reason: 'session_summary'
        });
        updated += 1;
        continue;
      } catch {
        // 目标行已被取代或不存在：退回新建，别把这条要点丢掉。
      }
    }
    const context: MemoryContext =
      fragmentById.get(point.merges[0])?.context ?? 'general';
    await createMemory(
      {
        userId,
        type: point.type,
        context,
        content: point.text,
        origin: 'inferred',
        confirmedAt: null,
        chatId: null,
        sourceMessageId: null
      },
      related
    );
    created += 1;
  }

  let archived = 0;
  for (const id of plan.archive) {
    if (await archiveMemory(id, userId)) archived += 1;
  }

  return { created, updated, duplicates: plan.duplicates, archived, rejected: plan.rejected };
}

/** 本进程内试过的会话（key 带 updatedAt）：失败不重试到死，成功则归档后自然不再满足条件。 */
const attempted = new Set<string>();

/**
 * 后台扫描入口：找出「已经结束」的对话，一轮最多总结一场。
 * 结束条件＝最后活动距今 ≥ SESSION_SUMMARY_IDLE_MINUTES，且仍有 ≥3 条活跃碎片。
 * 总结成功后碎片被归档，条件自然不成立，下一轮不会重复；失败记进 attempted，本进程内不再重试。
 */
export async function runSessionSummarySweep(userId: string): Promise<void> {
  if (!(await sessionSummaryEnabled())) return;
  const preferences = await getCognitivePreferences(userId).catch(() => null);
  if (!preferences || !preferences.memoryEnabled || preferences.memoryWritePaused) return;

  const cutoff = new Date(Date.now() - SESSION_SUMMARY_IDLE_MINUTES * 60_000);
  const chats = await prisma.chat.findMany({
    where: { userId, updatedAt: { lte: cutoff } },
    orderBy: { updatedAt: 'desc' },
    take: 8,
    select: { id: true, updatedAt: true }
  });
  if (chats.length === 0) return;

  const active = await listMemories(userId);
  for (const chat of chats) {
    const key = `${chat.id}:${chat.updatedAt.getTime()}`;
    if (attempted.has(key)) continue;
    const fragments = active.filter((memory) => memory.chatId === chat.id);
    if (fragments.length < SESSION_SUMMARY_MIN_FRAGMENTS) continue;
    attempted.add(key);
    const others = active.filter((memory) => memory.chatId !== chat.id);
    try {
      const outcome = await summarizeChatMemories(userId, fragments, others);
      if (outcome) {
        log.info('cognitive.session_summary', {
          userId,
          chatId: chat.id,
          created: outcome.created,
          updated: outcome.updated,
          duplicates: outcome.duplicates,
          archived: outcome.archived
        });
      }
    } catch {
      log.warn('cognitive.session_summary_failed', { userId, chatId: chat.id, reason: 'apply_failed' });
    }
    return;
  }
}
