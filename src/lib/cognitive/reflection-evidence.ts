import type { ConfidenceBand } from './confidence';
import type { PatternHypothesis, ReflectionFinding, ReflectableMemory } from './reflection-planner';
import { NEGATION_MARKERS } from './reflection-planner';
import { scoreByKeyword } from './retrieval';

/**
 * 反思的证据与措辞层（任务书 6.4 的反证 / 6.3 的多假设 / 6.5 的「候选不是结论」）。
 *
 * 6-B 只回答「有没有一件值得说的事」，这一层回答三件事：这件事有没有人反对、
 * 该用多肯定的口气说、以及**写之前有没有说错**。零模型：句子从常量表里选，
 * 数字只从 finding 里取，因果一律不写——规则算得出「你说过四次」，算不出「因为你在意」。
 *
 * 三条红线在这里是结构性的，不是靠约定：
 * 一、正文里的引号内容只能是用户自己说过的话（`memoryTexts` / `decisionTopics` 递进来的原文），
 *    拿不到原文就一个引号都不出现——系统绝不替用户造一句「他说过」。
 * 二、正文里出现的数字只能是 finding 的那两个，`criticizeReflection` 落库前再核一遍。
 *    引号里的数字不算：那是用户的原话，不是系统的断言，把它一起管会让带阿拉伯数字的记忆永远出不了洞察。
 * 三、critic 的返回值只有原因码，没有中文——它要进日志。
 *
 * 测试：tests/unit/cognitive-reflection-evidence.test.ts
 */

/** 档位下界。和记忆侧的 0.75/0.45 不是同一组数：那条讲的是「这一句可不可信」，这条讲的是「这一堆够不够成一个说法」。 */
export const HIGH_BAND_MIN = 0.7;
export const MEDIUM_BAND_MIN = 0.4;
/** 样本数到 6 就给满：七类规则里最高门槛是 3，6 已经是「不止一次观察」的两倍。 */
export const CONF_SAMPLES_FULL = 6;
/** 跨度到 60 天给满：和 UNRESOLVED_MIN_AGE_DAYS 同量级，短于一个月的观察窗不值得拿来定性。 */
export const CONF_SPAN_FULL_DAYS = 60;
export const CONF_COUNTER_PENALTY = 0.2;
/** 反证扣分最多次算三条：再多也只是同一件事被说了好几遍，不该把一条洞察扣到零。 */
export const CONF_COUNTER_MAX_COUNTED = 3;
/** 正文最多引这么几句原话：洞察要说的是「合起来看」，不是把用户的话抄一遍。 */
export const QUOTE_MAX = 3;

/** 因果断言词。出现任何一个就是 UNSOURCED_ASSERTION：这一层没有能算出因果的东西。 */
export const CAUSAL_MARKERS: readonly string[] = ['因为', '所以', '因此', '说明', '意味着', '原因是'];

/** 留出余地的说法。有反证时正文必须有一句，否则就是只报好消息。 */
export const HEDGE_MARKERS: readonly string[] = ['可能', '不一定', '也有几次'];

/** 有反证时追加的那一句。措辞层和 critic 用的是同一个串，所以「写了没有」这个问题不需要模糊匹配。 */
export const COUNTER_CLAUSE = '（也有几次说法不一样）';

const FRAMING: Record<ConfidenceBand, string> = {
  low: '这几句看着有关，但还说不定是不是一件事。',
  medium: '这几句说的是同一件事。',
  high: '这几句确实说的是同一件事。'
};

/** 6.3 的三种解释各自的句子。键集合由 PATTERN_HYPOTHESES 钉死： planner 加一种而这里没给句子，编译就过不去。 */
export const HYPOTHESIS_PHRASES: Record<PatternHypothesis, string> = {
  LONG_TERM_INTEREST: '可能是你长期在意的事',
  STAGED_PROJECT: '可能是一个分几步推进的事',
  TEMPORARY_LEARNING: '可能只是这一阵子在看的东西'
};

/** 七类洞察的标题。只有这一处，界面不再另立一份，否则同一个类型会有两个名字。 */
export const REFLECTION_TYPE_LABELS: Record<ReflectionFinding['type'], string> = {
  PATTERN: '反复出现的主题',
  GOAL_DRIFT: '目标换了方向',
  UNRESOLVED: '放了很久没下文',
  INTEREST_SHIFT: '兴趣换了地方',
  CONTRADICTION: '两句互相打脸',
  MILESTONE: '做成的一件事',
  DECISION_LESSON: '决策和它的结果'
};

/**
 * 引用行 id 的可见正文。调用方负责只递这条洞察真正引用的那几行——
 * 传进来的东西会被原样引号包住写进正文，所以它必须是用户说过的话，不能是系统加工过的摘要。
 */
export interface PhrasingInput {
  finding: ReflectionFinding;
  band: ConfidenceBand;
  /** 记忆 id → 解密后的正文。 */
  memoryTexts: ReadonlyMap<string, string>;
  /** 决策 id → 决策行的 topic 短句。 */
  decisionTopics: ReadonlyMap<string, string>;
  /** 反证条数（`findCounterEvidence` 的返回长度）。 */
  counterHits: number;
}

function hasNegation(text: string): boolean {
  return NEGATION_MARKERS.some((marker) => text.includes(marker));
}

/** 去掉引号包住的原文：那部分是用户的话，系统的措辞纪律不套在它头上。 */
function withoutQuotations(body: string): string {
  return body.replace(/「[^」]*」/g, '');
}

function digitsIn(text: string): string[] {
  return [...text.matchAll(/\d+/g)].map((match) => match[0]!);
}

/**
 * 找这条洞察的反证。只有两个确定性信号，都不需要理解句子：
 * 一、这一行被用户改过口（已取代）或撤过（RETRACTED）；
 * 二、这一行带否定词，而支持侧任何一句都不带——支持侧本来就是否定的时候，
 *    再找一句否定的不构成打脸，那是同一立场的第 N 次。
 * 相关度用读侧同一个 `scoreByKeyword`：出现第二套「相关」的定义，反证和召回就会各说各话。
 */
export function findCounterEvidence(
  finding: ReflectionFinding,
  pool: readonly ReflectableMemory[]
): string[] {
  if (finding.topicTokens.length === 0) return [];
  const byId = new Map(pool.map((memory) => [memory.id, memory]));
  const supportRows = finding.supportMemoryIds
    .map((id) => byId.get(id))
    .filter((memory): memory is ReflectableMemory => memory !== undefined);
  // 没有支持行就没有「相反」的基线：整个池子看起来都反对，那是判据坏了，不是证据多。
  if (supportRows.length === 0) return [];

  const alreadyCited = new Set([
    ...finding.supportMemoryIds,
    ...finding.counterMemoryIds,
    ...finding.supportDecisionIds
  ]);
  const candidates = pool.filter((memory) => !alreadyCited.has(memory.id));
  if (candidates.length === 0) return [];

  const query = finding.topicTokens.join(' ');
  // scoreByKeyword 只认 Retrievable（content + ISO recordedAt），所以把原行摊开、补上那两个字段：
  // 排完序拿回来的还是同一批行，判方向要用的 supersededAt / origin 就在上面，不必再回表查。
  const scored = scoreByKeyword(
    query,
    candidates.map((memory) => ({
      ...memory,
      content: memory.text,
      recordedAt: memory.recordedAt.toISOString()
    }))
  );
  const supportIsNegative = supportRows.some((memory) => hasNegation(memory.text));

  return scored
    .filter(({ memory: row, score }) => {
      if (score <= 0) return false;
      if (row.supersededAt !== null || row.origin === 'RETRACTED') return true;
      return hasNegation(row.text) && !supportIsNegative;
    })
    .map(({ memory: row }) => row.id);
}

/**
 * 反思自己的置信度。不复用 `assessConfidence`：那条吃的是「一条记忆的形状」（来源、确认时间、
 * 失效时间），而一条洞察是 N 条记忆的聚合，硬套就得给聚合编一个来源出来——那是假数据。
 * 这里只有三个数：样本多少、跨度多长、有几条反对。三个都来自 finding，没有第四个。
 */
export function reflectionConfidence(input: {
  sampleCount: number;
  observationSpanDays: number;
  counterHits: number;
}): { score: number; band: ConfidenceBand } {
  const samplePart = Math.min(1, Math.max(0, input.sampleCount) / CONF_SAMPLES_FULL) * 0.5;
  const spanPart = Math.min(1, Math.max(0, input.observationSpanDays) / CONF_SPAN_FULL_DAYS) * 0.5;
  const penalty =
    Math.min(Math.max(0, input.counterHits), CONF_COUNTER_MAX_COUNTED) * CONF_COUNTER_PENALTY;
  // 千分位取整：0.2 在二进制里不是 0.2，不取整的话 1-0.2*3 会变成 0.39999999999999997，
  // 一个用来定性的数字不该带这种尾巴。
  const score = Math.min(1, Math.max(0, samplePart + spanPart - penalty));
  const rounded = Math.round(score * 1000) / 1000;
  const band: ConfidenceBand =
    rounded >= HIGH_BAND_MIN ? 'high' : rounded >= MEDIUM_BAND_MIN ? 'medium' : 'low';
  return { score: rounded, band };
}

/**
 * 把一条 finding 写成标题和正文。
 *
 * 顺序是固定的：口气 → 计数 → 原话 → （PATTERN）三种解释 → （有反证）余地那一句。
 * 固定顺序才能让 critic 的「少了哪一段」变成字符串包含判断，也才能让同一条 finding 每次都得到同一个正文。
 */
export function phraseReflection(input: PhrasingInput): { title: string; body: string } {
  const { finding, band } = input;
  const parts: string[] = [FRAMING[band]];
  parts.push(`前后说过 ${finding.sampleCount} 次，跨度 ${finding.observationSpanDays} 天。`);

  const quotes = [
    ...finding.supportMemoryIds.map((id) => input.memoryTexts.get(id)),
    ...finding.supportDecisionIds.map((id) => input.decisionTopics.get(id))
  ].filter((text): text is string => typeof text === 'string' && text.length > 0);
  if (quotes.length > 0) {
    parts.push(`原话：${quotes.slice(0, QUOTE_MAX).map((text) => `「${text}」`).join('、')}。`);
  }

  // 规则分不开解释时一条都不选：三种一起给，让用户自己判——这是甲方案存在的全部理由。
  const phrases = finding.hypothesisKeys
    .map((key) => HYPOTHESIS_PHRASES[key as PatternHypothesis])
    .filter((phrase): phrase is string => typeof phrase === 'string');
  if (phrases.length > 0) parts.push(`分不开这几种解释：${phrases.join('；')}。`);

  if (input.counterHits > 0) parts.push(COUNTER_CLAUSE);

  return { title: REFLECTION_TYPE_LABELS[finding.type], body: parts.join('') };
}

export type CriticReason =
  | 'GHOST_CITATION'
  | 'UNSOURCED_ASSERTION'
  | 'COUNTER_UNMENTIONED'
  | 'COUNT_MISMATCH'
  | 'HYPOTHESIS_DROPPED';

export interface CriticInput {
  finding: ReflectionFinding;
  draft: { title: string; body: string };
  counterHits: number;
  /** 这次扫描真正读到的行 id（记忆与决策都算）：引用不在里面就是凭空造的。 */
  poolIds: readonly string[];
}

/**
 * 落库前的五道检查。任何一条命中都不写这一行——门槛 4、5 说的是「不许有无来源的断言」，
 * 那是一条写入规则，不是一个界面规则，所以它得长在写库之前。
 */
export function criticizeReflection(input: CriticInput): { accepted: boolean; reasons: CriticReason[] } {
  const { finding, draft, counterHits, poolIds } = input;
  const own = withoutQuotations(draft.body);
  const reasons: Set<CriticReason> = new Set();

  const known = new Set(poolIds);
  const cited = [...finding.supportMemoryIds, ...finding.counterMemoryIds, ...finding.supportDecisionIds];
  if (cited.some((id) => !known.has(id))) reasons.add('GHOST_CITATION');

  if (CAUSAL_MARKERS.some((marker) => own.includes(marker))) reasons.add('UNSOURCED_ASSERTION');

  if (counterHits > 0 && !HEDGE_MARKERS.some((marker) => own.includes(marker))) reasons.add('COUNTER_UNMENTIONED');

  const allowed = new Set([String(finding.sampleCount), String(finding.observationSpanDays)]);
  if (digitsIn(own).some((digit) => !allowed.has(digit))) reasons.add('COUNT_MISMATCH');

  if (finding.hypothesisKeys.some((key) => !phrasesPresent(draft, key))) reasons.add('HYPOTHESIS_DROPPED');

  const sorted = [...reasons].sort();
  return { accepted: sorted.length === 0, reasons: sorted };
}

/**
 * 这个解释到底写没写进正文。
 *
 * 认不出来的键（planner 将来加了新解释而措辞表没跟上）一律算「没写」：宁可这条洞察整条不落地，
 * 也不要它带着一个少了解释的正文落库——那正好是 6.3 禁止的那种「替用户断定」。
 */
function phrasesPresent(draft: { title: string; body: string }, key: string): boolean {
  const phrase = HYPOTHESIS_PHRASES[key as PatternHypothesis];
  if (phrase === undefined) return false;
  return draft.body.includes(phrase);
}
