import type { AiProvider } from '@prisma/client';
import { streamChatCompletion } from '@/lib/ai';
import { getRawSystemSetting } from '@/lib/config';
import { log } from '@/lib/logger';
import { getProviderForUser, resolveDefaultProvider } from '@/lib/providers';
import {
  MEMORY_CANDIDATE_MAX_CHARS,
  MEMORY_CANDIDATE_MIN_CHARS,
  MEMORY_CANDIDATES_PER_TURN,
  type MemoryCandidate
} from './memory-extractor';
import type { MemoryType } from './policy';

/**
 * 记忆审核 AI：这一轮到底值不值得写进长期库，由它说了算（不是规则的附议者）。
 *
 * 分工：规则层是**粗筛 + 兜底 + 命令通道**，审核模型是**闸门**。
 * - 闸门开（后台「系统配置」的 `cognitiveAiMemoryEnabled`，老库回落 env `COGNITIVE_AI_MEMORY=1`）：
 *   每个有实质内容的用户轮次都问一次模型（一轮一次，跑在后台 worker 里，不落在对话关键路径上），
 *   它返回什么就记什么；返回空数组表示「这一轮不值得长期记」，于是这一轮一条都不落库——
 *   包括规则已经命中、但它判为一次性的那些。这正是「不是每句对话都被长期记忆」的落点。
 * - 闸门不开：写侧逐字回到纯规则路径，零行为变化。
 * - 模型不可用、超时、输出解析不出数组：回退规则候选（记一次 warn）。审核模型坏掉时
 *   宁可少判、不可清空用户记忆，所以这里的失败方向是「照旧按规则记」，不是「什么都不记」。
 * - 用户当面命令「记住…」的那句不过闸门（见 `extractMemoryDirectives`）：判断题可以给 AI 做，
 *   用户明确的指令不能被他自己的工具否掉。
 *
 * 模型只做一件事：判断值不值得长期记、给出类型。它不写库、不做最终保存决策——要不要落库、
 * 要不要先问、会不会取代旧记忆，仍由现有 write-decision 按用户策略裁决（任务书最终原则）。
 * 它也不许改写措辞：输出的每条必须能在用户原话里逐字找到（`keepVerbatimCandidates` 负责剔除），
 * 否则「系统记住了用户说的话」这句话就是假的，`origin=explicit` 也跟着失真。
 *
 * 测试：tests/unit/cognitive-memory-extractor-ai.test.ts、tests/unit/cognitive-memory-module.test.ts
 */

/** 后台提取的硬截止：比对话读侧宽，但远小于模型默认 120s，避免一条坏请求拖住整轮欠账。 */
export const AI_EXTRACTION_TIMEOUT_MS = 30_000;

const ALLOWED_TYPES: readonly MemoryType[] = ['fact', 'preference', 'goal', 'project', 'decision', 'emotion'];

const SYSTEM_PROMPT = [
  '你是长期记忆审核员。给你用户这一轮说的话、规则初筛出的候选，以及已经存着的他的长期记忆。',
  '你的任务是决定这一轮里**哪些话值得写进长期记忆**，只输出那部分。',
  '值得记：会改变系统以后如何理解这个用户的东西——稳定身份事实、长期偏好、长期目标、正在做的项目、明确的决策、反复或持续出现的状态，以及和他身体、健康、生活重大变化有关的具体经历。',
  '不值得记：一次性闲聊和寒暄、当天才有效的安排、临时的犹豫和情绪宣泄、普通知识问答、跟用户本人无关的内容、以及没有信息量的复述。',
  '宁缺毋滥：整轮都没有值得长期记的内容就输出 []，不要为了有输出而勉强挑一条。',
  'text 取用户原话里的**一个完整分句**（到逗号或句号为止的那一段）：不许加字（包括主语和连接词）、不许改写、不许概括；',
  '也不要把一句连续的话拆成几个碎片——「改成每天游泳了」这种新说法被拆丢，比多记一条更糟。',
  '用户是在改口（不再做某事、换成别的、搬到别处、决定换掉）时：把说明**新状态**的那个分句记下来，',
  '并在 replaces 里填上他被推翻的那条已有记忆的 id；没有对应的旧记忆就不填 replaces。',
  'replaces 只能用下面「已有记忆」里给到的 id，不许自己编。',
  'type 只能是 fact/preference/goal/project/decision/emotion 之一。疑问句不是事实。',
  '只输出一个 JSON 数组，元素形如 {"text":"用户原话分句","type":"fact","replaces":"m-3"}（replaces 可省略）；',
  '不要输出任何解释或多余字符。'
].join('\n');

/** 审核提示词原文（导出给评测与探针复用，保证测的就是线上跑的这一段）。 */
export const AI_REVIEW_SYSTEM_PROMPT = SYSTEM_PROMPT;

/** 喂给审核模型的已有记忆条数上限：再多只是把提示词撑大，改口的旧说法几乎总在最近这批里。 */
export const AI_REVIEW_EXISTING_MAX = 20;
/** 已有记忆正文进提示词时的截断长度（只为让模型认出那件事，不需要全文）。 */
const AI_REVIEW_EXISTING_TEXT_MAX = 80;

/** 审核模型可以引用「推翻哪条旧记忆」的那些行。只带 id、类型和正文片段。 */
export interface ExistingMemoryBrief {
  id: string;
  type: MemoryType;
  content: string;
}

/** 这一轮发给审核模型的 user 消息正文：用户原话 + 规则初筛候选 + 已有记忆（可引用 id）。 */
export function buildReviewUserPrompt(
  content: string,
  ruleCandidates: readonly MemoryCandidate[],
  existing: readonly ExistingMemoryBrief[] = []
): string {
  const parts = [
    '用户这一轮说的话：',
    content,
    '',
    '规则初筛候选（只是提示，不是你必须采纳的清单；不值得长期记的要剔除，值得记而你看到的原话片段可以补）：',
    JSON.stringify(ruleCandidates.map((candidate) => ({ text: candidate.text, type: candidate.type })))
  ];
  if (existing.length > 0) {
    parts.push(
      '',
      '已有记忆（改口时用 replaces 填这里的 id，一次最多推翻一条）：',
      JSON.stringify(
        existing
          .slice(0, AI_REVIEW_EXISTING_MAX)
          .map((row) => ({ id: row.id, type: row.type, text: row.content.slice(0, AI_REVIEW_EXISTING_TEXT_MAX) }))
      )
    );
  }
  return parts.join('\n');
}

/**
 * 是否启用 AI 二级抽取。后台「系统配置」里的 `cognitiveAiMemoryEnabled` 说了算；
 * 老库还没有这一行时回落 env `COGNITIVE_AI_MEMORY`（其余取值一律按关处理）。
 */
export async function aiMemoryExtractionEnabled(): Promise<boolean> {
  const raw = await getRawSystemSetting('cognitiveAiMemoryEnabled').catch(() => null);
  if (raw !== null) return raw === true || raw === 'true';
  return process.env.COGNITIVE_AI_MEMORY === '1';
}

/**
 * AI 提取的调用计数（任务书 §9.6「每轮额外记忆模型调用数」）。进程内累加，只数「真的发起了
 * 模型调用」的轮次，模型坏了/解析失败也各记一次（成本已经发生）。默认关时恒为 0。
 */
let aiExtractionCallCount = 0;

export function recordAiExtractionCall(): void {
  aiExtractionCallCount += 1;
}

export function aiExtractionCallCountValue(): number {
  return aiExtractionCallCount;
}

/** 测试用：把计数归零。 */
export function resetAiExtractionCallCount(): void {
  aiExtractionCallCount = 0;
}

/**
 * 解析「记忆审核用的模型」。默认回落到该用户的默认聊天模型；设了 env
 * `COGNITIVE_AI_MEMORY_PROVIDER=<providerId>` 就改用那个指定的 provider——记忆审核可以和
 * 聊天用不同的模型（比如审核用更便宜/更稳的），这是这个接口的意义。
 *
 * 指定的 provider 取不到（id 写错、被删、该用户无权用）时不报错，记一条日志回退默认模型：
 * 审核模型是增益，配错不该把这一轮记忆清零。
 */
export async function resolveMemoryExtractionProvider(userId: string): Promise<AiProvider> {
  // 后台系统配置里的 cognitiveExtractionProviderId 优先；没配过时回落 env。
  const fromSetting = (await getRawSystemSetting('cognitiveExtractionProviderId').catch(() => null)) as string | null;
  const configured = fromSetting || process.env.COGNITIVE_AI_MEMORY_PROVIDER;
  if (configured) {
    try {
      return await getProviderForUser(configured, userId);
    } catch {
      log.warn('cognitive.ai_extraction_provider_fallback', { userId, providerId: configured });
    }
  }
  return resolveDefaultProvider(userId);
}

/**
 * 从模型返回的文本里解析候选。模型不一定支持 structured outputs，所以防御性地抓第一个 JSON 数组：
 * 剥掉可能的 ```json 包裹、取第一个 '[' 到最后一个 ']'。解析不出合法数组就返回 null（调用方回退规则）。
 * 逐条校验：text 是非空字符串且不超长，type 在六类里；问句、含「忽略系统规则」之类指令的不收。
 * `allowedReplaceIds` 给了才认 `replaces` 字段，而且只认这份集合里的 id——模型自己编的 id 一律丢弃，
 * 指错旧记忆比不指更贵（那会把一条还有效的说法归档掉）。
 */
export function parseAiCandidates(raw: string, allowedReplaceIds?: ReadonlySet<string>): MemoryCandidate[] | null {
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
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const text = (item as { text?: unknown }).text;
    const type = (item as { type?: unknown }).type;
    if (typeof text !== 'string' || typeof type !== 'string') continue;
    if (!ALLOWED_TYPES.includes(type as MemoryType)) continue;
    const trimmed = text.trim();
    if (trimmed.length < MEMORY_CANDIDATE_MIN_CHARS || trimmed.length > MEMORY_CANDIDATE_MAX_CHARS) continue;
    if (/[?？]\s*$/.test(trimmed)) continue;
    const key = trimmed.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate: MemoryCandidate = { text: trimmed, type: type as MemoryType };
    const replaces = (item as { replaces?: unknown }).replaces;
    if (allowedReplaceIds && typeof replaces === 'string' && allowedReplaceIds.has(replaces)) {
      candidate.supersedesId = replaces;
    }
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * 问一次审核模型，拿到「这一轮值得长期记的东西」。
 *
 * 返回 null 表示这次审核没给出可用结论（模型错、超时、输出解析不出数组）——调用方据此回退规则候选。
 * 返回数组（含空数组）表示审核结论，**它就是最终候选清单**：规则命中但没被列进来的句子不再落库。
 *
 * 一次失败会重试一次（总共至多两趟）：实测免费档的审核模型在连着问时会零星直接调用失败，
 * 而失败的方向是「回退规则」，也就是这一轮又变成规则抽到什么记什么——正是这套设计要避免的形状。
 * 重试只多花一次调用，不改变任何判定口径。
 *
 * 日志只记 id 和计数，不记正文（任务书 5.5）。
 */
export async function reviewTurnWithAI(
  userId: string,
  content: string,
  ruleCandidates: readonly MemoryCandidate[],
  provider: AiProvider,
  existing: readonly ExistingMemoryBrief[] = []
): Promise<MemoryCandidate[] | null> {
  const userPrompt = buildReviewUserPrompt(content, ruleCandidates, existing);
  const allowedReplaceIds = new Set(existing.map((row) => row.id));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await collectReviewText(userId, provider, userPrompt);
    if (raw === null) continue;
    const parsed = parseAiCandidates(raw, allowedReplaceIds);
    if (parsed === null) {
      log.warn('cognitive.ai_extraction_failed', { userId, reason: 'parse_failed', attempt });
      continue;
    }
    const { kept, dropped } = filterVerbatimCandidates(parsed, content);
    if (dropped > 0) {
      // 模型改写了措辞或凭空补了信息。丢掉那几条；但如果它挑的每一条都不是原话，那更像是
      // 没按格式出牌而不是判「都不值得记」——那种情况整趟结论作废，回退规则，别把记忆清空。
      log.warn('cognitive.ai_review_not_verbatim', { userId, dropped, kept: kept.length, attempt });
      if (kept.length === 0) continue;
    }
    return kept.slice(0, MEMORY_CANDIDATES_PER_TURN);
  }
  return null;
}

/** 跑一趟模型把流式输出攒成文本；调用失败返回 null 并记一条日志。 */
async function collectReviewText(userId: string, provider: AiProvider, userPrompt: string): Promise<string | null> {
  recordAiExtractionCall();
  let raw = '';
  try {
    for await (const event of streamChatCompletion({
      provider,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      timeoutMs: AI_EXTRACTION_TIMEOUT_MS
    })) {
      if (event.type === 'delta' && event.text) raw += event.text;
    }
  } catch {
    log.warn('cognitive.ai_extraction_failed', { userId, reason: 'model_error' });
    return null;
  }
  return raw;
}

/**
 * 只保留能在用户原话里逐字找到的条目。
 *
 * 比对时两侧都去掉空白和常见标点：模型很爱把「我喜欢黑咖啡」回成「我喜欢黑咖啡。」，
 * 那是同一句话，不该被当成改写；但它一旦回成「用户偏爱黑咖啡」，就不是原话了。
 * 这一步是 `origin=explicit`（用户亲口说的）这条来源声明的前提，不是可选的整洁癖。
 */
export function filterVerbatimCandidates(
  candidates: readonly MemoryCandidate[],
  content: string
): { kept: MemoryCandidate[]; dropped: number } {
  const haystack = normalizeForContainment(content);
  const kept = candidates.filter((candidate) => haystack.includes(normalizeForContainment(candidate.text)));
  return { kept, dropped: candidates.length - kept.length };
}

/** 去空白与常见标点、转小写：只为「是不是原话片段」这个判断服务，不用于入库正文。 */
export function normalizeForContainment(text: string): string {
  return text.replace(/[\s。，、！!？?；;：:.…·\"'“”‘’（）()【】《》\-_—~～]/g, '').toLowerCase();
}

/**
 * 这一轮值不值得为它花一次模型调用。
 *
 * 审核模型是按调用付费的，而对话里大量的轮次是「好的」「嗯嗯」「哈哈，谢谢啦」这种零信息应答。
 * 闸门开在这些句子上前置拦一道：太短、只剩语气词（可叠加、可带句末助词）、或者根本没有
 * 字母/数字/汉字（纯 emoji、纯符号）就不问模型，直接按规则那一套走（那种轮次规则也抽不出东西）。
 */
const PHATIC_TOKEN =
  '(?:好的?|嗯+|哦+|噢+|啊+|哈+|嘻+|嘿+|呵+|行|可以|没事|不用|不必|谢[了谢]?|收到|知道了?|明白|懂了|是的?|对+|没问题|随便|再见|拜拜|OK|ok|Ok)';
/** 只在句末剥掉的语气助词；「哈哈」这类不会因此变空，因为剥完还剩下的字必须由词表吃掉。 */
const TRAILING_PARTICLE_RE = /[啦呀啊哦噢呢吧哈唔呗哟~～]+$/;
const PADDING_RE = /^[\s。.!~～、，,]+|[\s。.!~～、，,]+$/g;
const HAS_CONTENT_RE = /[0-9A-Za-z一-龥]/;
const REVIEW_MIN_CHARS = 6;

export function isReviewWorthwhile(content: string): boolean {
  const text = content.trim();
  if (text.length < REVIEW_MIN_CHARS) return false;
  if (!HAS_CONTENT_RE.test(text)) return false;
  const compact = text.replace(TRAILING_PARTICLE_RE, '').replace(PADDING_RE, '');
  // 整串能被「语气词 + 标点」重复吃完，就是纯寒暄：「好的，谢谢啦」「嗯嗯，知道了哈」。
  return !new RegExp(`^(?:${PHATIC_TOKEN}[\\s。.!~～、，,]*)+$`).test(compact);
}