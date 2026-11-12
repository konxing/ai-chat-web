import { prisma } from '@/lib/prisma';
import { decryptString } from '@/lib/crypto';
import { cognitiveColumnAad, cognitiveColumnCoord } from './encrypted-columns';
import { decryptCognitiveString } from './aad';
import { log } from '@/lib/logger';
import { streamChatCompletion } from '@/lib/ai';
import { getRawSystemSetting } from '@/lib/config';
import { AI_EXTRACTION_TIMEOUT_MS, resolveMemoryExtractionProvider } from './memory-extractor-ai';
import { confirmCandidate, rejectCandidate } from './memory-candidates';
import { setDecisionStatus } from './decisions';
import { createProfileEntry } from './user-profile';
import { getCognitivePreferences } from './preferences';
import { readProfileScreen, profileGates } from './profile-reads';
import { addDismissedProfileKeys, profileCandidateKey, readDismissedProfileKeys } from './profile-dismissed';
import { listMemories } from './memories';
import type { ProfileCandidate } from './profile-candidates';

/**
 * 待确认条目的自动裁决（pending confirmation sweep）。
 *
 * 三处会「等人点头」：记忆候选（PENDING）、决策记录（PENDING_CONFIRM）、画像建议（派生列表）。
 * 用户明确要求：**一天没处理就交给 AI 决定**——保留还是丢弃。这一层在后台扫描里跑：
 * 找出创建超过 24 小时仍待处理的条目，一次性交给审核模型逐条判 keep/drop，再按判定执行：
 * - 记忆候选：keep → 走用户点「记住」的同一条链路（confirmCandidate）；drop → 拒绝（rejectCandidate）。
 * - 决策记录：keep → CONFIRMED；drop → REJECTED（两者都有状态机兜底，重复处理会 409，吞掉即可）。
 * - 画像建议：keep → 写进画像（createProfileEntry）；drop → 记进「已忽略」名单，
 *   画像读侧据此不再摆出这一条（建议是派生的，必须落一个标记才算"删掉"）。
 *
 * 边界：
 * 一、只在条目确实超过 24 小时时才跑；一轮最多处理 10 条、一次模型调用。
 * 二、模型失败/输出解析不出数组 → 什么都不改，条目继续等（宁可不处理，也不替用户瞎记）。
 * 三、开关 `cognitiveAutoConfirmEnabled`（后台「系统配置 → 记忆审核」），关掉后一次都不调。
 * 四、进程内按用户每小时至多尝试一次：失败不每个 tick 都重试，免得坏模型把调用打光。
 *
 * 测试：tests/unit/cognitive-pending-confirmation.test.ts
 */

/** 多少小时内没处理才交给 AI。用户口径：一天。 */
export const AUTO_CONFIRM_AFTER_HOURS = 24;
/** 一轮最多处理的条目数（跨三类合计）。 */
export const AUTO_CONFIRM_MAX_ITEMS = 10;
/** 进程内重试间隔：同一用户最多每小时尝试一次。 */
export const AUTO_CONFIRM_RETRY_MS = 60 * 60 * 1000;

export const AUTO_CONFIRM_PROMPT = [
  '你是用户的记忆管理员。以下条目是用户在 24 小时内没有处理的「待确认」项。',
  '请逐条判断应当保留（keep）还是丢弃（drop）。',
  '保留的标准：稳定、长期有用、与用户本人有关（身份、偏好、目标、正在做的项目、明确的决定）。',
  '丢弃的标准：一次性或临时的安排、重复、没有信息量、与用户本人无关。',
  '宁缺毋滥：不确定就丢弃。',
  '只输出一个 JSON 数组，元素形如 {"id":"原样返回的 id","action":"keep"} 或 {"id":"...","action":"drop"}；不要输出任何解释。'
].join('\n');

export type AutoConfirmKind = 'memory' | 'decision' | 'profile';

export interface AutoConfirmItem {
  /** 稳定 id：`mem:<id>` / `dec:<id>` / `prof:<key>`。模型原样回传。 */
  id: string;
  kind: AutoConfirmKind;
  text: string;
  /** 画像建议的源 id（只在 kind=profile 时有值，执行时写进画像条目的来源）。 */
  sourceMemoryIds?: string[];
  sourceReflectionIds?: string[];
}

export async function autoConfirmEnabled(): Promise<boolean> {
  const raw = await getRawSystemSetting('cognitiveAutoConfirmEnabled').catch(() => null);
  if (raw !== null) return raw === true || raw === 'true';
  // 老库还没这行时：用户口径是「默认开」，env 只用来显式覆盖（=0 关），不是默认值本身。
  if (process.env.COGNITIVE_AUTO_CONFIRM !== undefined) return process.env.COGNITIVE_AUTO_CONFIRM === '1';
  return true;
}

/** 解析模型裁决。只认清单里出现过的 id，action 只认 keep/drop；重复 id 以第一次为准。 */
export function parseAutoConfirmVerdicts(
  raw: string,
  allowedIds: ReadonlySet<string>
): Map<string, 'keep' | 'drop'> | null {
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
  const verdicts = new Map<string, 'keep' | 'drop'>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    const action = (item as { action?: unknown }).action;
    if (typeof id !== 'string' || !allowedIds.has(id)) continue;
    if (action !== 'keep' && action !== 'drop') continue;
    if (!verdicts.has(id)) verdicts.set(id, action);
  }
  return verdicts;
}

interface PendingRow {
  kind: AutoConfirmKind;
  /** 原始行 id（画像建议没有行，用键）。 */
  rawId: string;
  item: AutoConfirmItem;
  content: string;
}

/**
 * 收齐三类待处理项。全部按「创建超过 24 小时」过滤；画像建议的年龄按来源记忆的 recordedAt 算。
 * 读不到的（解不开密文等）直接跳过——自动裁决是增益，不该因为一条坏行整轮失败。
 */
async function collectPending(userId: string, cutoff: Date, now: Date): Promise<PendingRow[]> {
  const rows: PendingRow[] = [];

  const candidates = await prisma.memoryCandidate.findMany({
    where: { userId, status: 'PENDING', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: AUTO_CONFIRM_MAX_ITEMS
  });
  for (const row of candidates) {
    try {
      const content = decryptCognitiveString(
        row.contentCiphertext,
        cognitiveColumnCoord('MemoryCandidate', 'contentCiphertext', userId, row.id)
      );
      rows.push({
        kind: 'memory',
        rawId: row.id,
        content,
        item: { id: `mem:${row.id}`, kind: 'memory', text: content }
      });
    } catch {
      /* 跳过坏行 */
    }
  }

  const decisions = await prisma.decisionRecord.findMany({
    where: { userId, status: 'PENDING_CONFIRM', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: AUTO_CONFIRM_MAX_ITEMS
  });
  for (const row of decisions) {
    try {
      const topic = decryptString(row.topicCiphertext, cognitiveColumnAad('DecisionRecord', 'topicCiphertext', userId, row.id));
      const choice = decryptString(row.choiceCiphertext, cognitiveColumnAad('DecisionRecord', 'choiceCiphertext', userId, row.id));
      const text = `决定：${topic}；选择：${choice}`;
      rows.push({
        kind: 'decision',
        rawId: row.id,
        content: text,
        item: { id: `dec:${row.id}`, kind: 'decision', text }
      });
    } catch {
      /* 跳过坏行 */
    }
  }

  // 画像建议：没超过 24 小时的先不动（给用户留出自己点的时间）。
  try {
    const gates = await profileGates(userId);
    if (gates.userModelEnabled) {
      const screen = await readProfileScreen(userId, now, gates);
      const memories = await listMemories(userId);
      const recordedAt = new Map(memories.map((memory) => [memory.id, new Date(memory.recordedAt).getTime()]));
      const dismissed = await readDismissedProfileKeys(userId);
      for (const candidate of screen.candidates) {
        const key = profileCandidateKey(candidate);
        if (dismissed.has(key)) continue;
        const sourceTimes = candidate.sourceMemoryIds
          .map((id) => recordedAt.get(id))
          .filter((value): value is number => typeof value === 'number');
        if (sourceTimes.length === 0) continue;
        if (Math.max(...sourceTimes) > cutoff.getTime()) continue;
        rows.push({
          kind: 'profile',
          rawId: key,
          content: candidate.content,
          item: {
            id: `prof:${key}`,
            kind: 'profile',
            text: candidate.content,
            sourceMemoryIds: candidate.sourceMemoryIds,
            sourceReflectionIds: candidate.sourceReflectionIds
          }
        });
      }
    }
  } catch {
    /* 画像读侧失败就只处理另外两类 */
  }

  return rows.slice(0, AUTO_CONFIRM_MAX_ITEMS);
}

export interface AutoConfirmOutcome {
  kept: number;
  dropped: number;
  failed: number;
}

const lastAttemptAt = new Map<string, number>();
let lastAttemptCleanupAt = 0;

/**
 * 扫描入口：把这个用户超时未处理的条目交给模型裁决。
 * 返回 null 表示这轮没做事（开关关着/没到重试时间/没有超时条目/模型失败）。
 */
export async function runAutoConfirmSweep(userId: string): Promise<AutoConfirmOutcome | null> {
  try {
    return await sweepOnce(userId);
  } catch {
    // 扫描本身出错（库抖动、某张表缺行）不该把整轮 worker 带下水：条目继续等，下一小时再试。
    log.warn('cognitive.auto_confirm_failed', { userId, reason: 'sweep_failed' });
    return null;
  }
}

async function sweepOnce(userId: string): Promise<AutoConfirmOutcome | null> {
  if (!(await autoConfirmEnabled())) return null;
  const preferences = await getCognitivePreferences(userId).catch(() => null);
  if (!preferences || !preferences.memoryEnabled) return null;

  const now = new Date();
  const timestamp = now.getTime();
  if (timestamp - lastAttemptCleanupAt >= AUTO_CONFIRM_RETRY_MS) {
    lastAttemptCleanupAt = timestamp;
    for (const [id, attemptedAt] of lastAttemptAt) {
      if (timestamp - attemptedAt >= AUTO_CONFIRM_RETRY_MS) lastAttemptAt.delete(id);
    }
  }
  const previous = lastAttemptAt.get(userId);
  if (previous !== undefined && timestamp - previous < AUTO_CONFIRM_RETRY_MS) return null;
  const cutoff = new Date(now.getTime() - AUTO_CONFIRM_AFTER_HOURS * 60 * 60 * 1000);
  const pending = await collectPending(userId, cutoff, now);
  if (pending.length === 0) return null;

  lastAttemptAt.set(userId, Date.now());
  const provider = await resolveMemoryExtractionProvider(userId);

  const userPrompt = [
    '待确认条目（id / 类型 / 内容）：',
    JSON.stringify(pending.map((row) => ({ id: row.item.id, kind: row.item.kind, text: row.content.slice(0, 300) })))
  ].join('\n');

  let raw = '';
  try {
    for await (const event of streamChatCompletion({
      provider,
      messages: [
        { role: 'system', content: AUTO_CONFIRM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      timeoutMs: AI_EXTRACTION_TIMEOUT_MS
    })) {
      if (event.type === 'delta' && event.text) raw += event.text;
    }
  } catch {
    log.warn('cognitive.auto_confirm_failed', { userId, reason: 'model_error', count: pending.length });
    return null;
  }

  const verdicts = parseAutoConfirmVerdicts(raw, new Set(pending.map((row) => row.item.id)));
  if (verdicts === null) {
    log.warn('cognitive.auto_confirm_failed', { userId, reason: 'parse_failed', count: pending.length });
    return null;
  }

  let kept = 0;
  let dropped = 0;
  let failed = 0;
  const profileDrops: string[] = [];
  for (const row of pending) {
    const action = verdicts.get(row.item.id);
    if (!action) continue;
    try {
      if (row.kind === 'memory') {
        if (action === 'keep') {
          await confirmCandidate(row.rawId, userId);
          kept += 1;
        } else {
          await rejectCandidate(row.rawId, userId);
          dropped += 1;
        }
      } else if (row.kind === 'decision') {
        await setDecisionStatus(userId, row.rawId, action === 'keep' ? 'confirm' : 'reject');
        if (action === 'keep') kept += 1;
        else dropped += 1;
      } else if (action === 'keep') {
        await createProfileEntry({
          userId,
          content: row.content,
          sourceMemoryIds: row.item.sourceMemoryIds ?? [],
          sourceReflectionIds: row.item.sourceReflectionIds ?? []
        });
        kept += 1;
      } else {
        profileDrops.push(row.rawId);
        dropped += 1;
      }
    } catch {
      // 已经被用户手动处理过（状态 409）、或行已删除：跳过，不改其它条目的结论。
      failed += 1;
    }
  }
  await addDismissedProfileKeys(userId, profileDrops).catch(() => undefined);

  if (kept + dropped + failed > 0) {
    log.info('cognitive.auto_confirm', { userId, kept, dropped, failed });
  }
  return { kept, dropped, failed };
}
