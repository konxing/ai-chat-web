import type { AiProvider } from '@prisma/client';
import { streamChatCompletion } from '@/lib/ai';
import { log } from '@/lib/logger';
import { getProviderForUser, resolveDefaultProvider } from '@/lib/providers';
import { MEMORY_CANDIDATE_MAX_CHARS, MEMORY_CANDIDATE_MIN_CHARS, type MemoryCandidate } from './memory-extractor';
import type { MemoryType } from './policy';

/**
 * 选择性编码的第二级：AI 候选筛选（混合式记忆升级 Phase 2，借鉴 Mem0 / LangMem）。
 *
 * 成本红线（任务书 §9）：**不是每条消息都调模型**。这一层只在规则预筛已经抽出候选时才触发，
 * 一轮一次、跑在后台 worker 里，不落在对话关键路径上。规则一个候选都没抽到的普通闲聊，
 * 压根不会走到这里。
 *
 * 默认关闭：由 `aiMemoryExtractionEnabled()`（env `COGNITIVE_AI_MEMORY=1`）控制。关着时
 * 写侧逐字回到纯规则路径，零行为变化。模型不可用、超时、输出解析失败一律回退到规则候选，
 * 绝不因为 AI 坏了就丢记忆或把对话带下水。
 *
 * 模型只做一件事：从用户这一轮原话里挑出**有长期价值**的陈述，给出类型。它不写库、不做最终
 * 保存决策——要不要落库、要不要先问、会不会取代旧记忆，仍由现有 write-decision 按用户策略裁决。
 * 这样 AI 的推断不会凌驾于用户明确策略之上（任务书最终原则）。
 *
 * 测试：tests/unit/cognitive-memory-extractor-ai.test.ts
 */

/** 后台提取的硬截止：比对话读侧宽，但远小于模型默认 120s，避免一条坏请求拖住整轮欠账。 */
export const AI_EXTRACTION_TIMEOUT_MS = 30_000;

const ALLOWED_TYPES: readonly MemoryType[] = ['fact', 'preference', 'goal', 'project', 'decision', 'emotion'];

const SYSTEM_PROMPT = [
  '你是一个记忆筛选器。给你用户这一轮说的话，以及规则已经初筛出的候选。',
  '请只挑出对长期理解用户有价值的陈述（稳定事实、长期目标、稳定偏好、重要项目或决策、重要经历）。',
  '忽略一次性闲聊、临时想法、普通知识问答、与用户个人无关的内容。',
  '不要编造用户没说的信息，不要把疑问句当成事实。',
  '每条用用户的原话或贴近原话的简洁陈述。type 只能是 fact/preference/goal/project/decision/emotion 之一。',
  '只输出一个 JSON 数组，元素形如 {"text":"...","type":"fact"}；没有值得记的就输出 []。不要输出任何解释。'
].join('\n');

/** 是否启用 AI 二级抽取。默认关；只认 env 的明确 '1'，其余一律按关处理。 */
export function aiMemoryExtractionEnabled(): boolean {
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
  const configured = process.env.COGNITIVE_AI_MEMORY_PROVIDER;
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
 */
export function parseAiCandidates(raw: string): MemoryCandidate[] | null {
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
    candidates.push({ text: trimmed, type: type as MemoryType });
  }
  return candidates;
}

/**
 * 调一次模型 refine 候选。返回 null 表示「这次 AI 没给出可用结果，回退规则」——
 * 调用方据此保留规则候选，而不是把这一轮的记忆清空。日志只记 id 和原因，不记正文（任务书 5.5）。
 */
export async function refineCandidatesWithAI(
  userId: string,
  content: string,
  ruleCandidates: readonly MemoryCandidate[],
  provider: AiProvider
): Promise<MemoryCandidate[] | null> {
  recordAiExtractionCall();
  const userPrompt = [
    '用户这一轮说的话：',
    content,
    '',
    '规则初筛候选（供参考，可修正/补充/剔除）：',
    JSON.stringify(ruleCandidates.map((candidate) => ({ text: candidate.text, type: candidate.type })))
  ].join('\n');

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
  const parsed = parseAiCandidates(raw);
  if (parsed === null) {
    log.warn('cognitive.ai_extraction_failed', { userId, reason: 'parse_failed' });
    return null;
  }
  return parsed;
}