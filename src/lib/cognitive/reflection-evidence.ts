import type { ConfidenceBand } from './confidence';
import { CLAUSE_SPLIT_RE } from './decision-extractor';
import type { HypothesisKey, ReflectionFinding, ReflectableMemory } from './reflection-planner';
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
 * 一、标题和正文里的引号内容只能是用户自己说过的话（`memoryTexts` / `decisionTopics` 递进来的原文），
 *    拿不到原文就没有标题——critic 会把整条挡下。这一条对标题比对正文更要紧：它是这一屏字号最大的
 *    一行，用户最容易把它读成「系统对我的总结」，所以它更不该是系统写的话。
 * 二、正文里出现的数字只能是 finding 的那两个，`criticizeReflection` 落库前再核一遍。
 *    引号里的数字不算：那是用户的原话，不是系统的断言，把它一起管会让带阿拉伯数字的记忆永远出不了洞察。
 * 三、critic 的返回值只有原因码，没有中文——它要进日志。
 *
 * 还有一条不属于红线但同样要紧的：**一句解释只有一个去处**，就是 `phraseReflection` 返回的
 * `alternatives`。正文不抄它（抄第二遍就是同一屏里系统把同一句话说两次，两处迟早分叉），
 * 界面单独渲染它一行，critic 也只核 `alternatives`。
 *
 * 测试：tests/unit/cognitive-reflection-evidence.test.ts（反证 / 置信度 / critic 六道）、
 * tests/unit/cognitive-reflection-title.test.ts（标题取自原话，以及「类型名只有一份」那条静态断言）、
 * tests/unit/cognitive-reflection-hypotheses.test.ts（哪几类有解释、解释只写在一处）。
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
/**
 * 标题的字数上限。标题是这一屏字号最大的一行，超了它就不是标题而是正文，
 * 所以截断规则必须是可见的：宁可只留第一个分句，也不在词中间切断。
 */
export const REFLECTION_TITLE_MAX_CHARS = 40;
/** 截断标记。它出现就等于「原文还有」，不让标题装作是一句完整的话。 */
export const REFLECTION_TITLE_TRUNCATION_MARK = '…';

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

/**
 * 每种解释的句子。键集合由 `ALL_HYPOTHESIS_KEYS` 钉死：规则层加一种解释而这里没给句子，编译就过不去。
 *
 * 每一句都以「可能」开头，都不带因果词、不带数字——它们是候选，不是结论。一句解释只写在这一处：
 * 正文不抄第二遍（抄两遍等于系统把同一句话讲两次，而且两次迟早分叉）。
 */
export const HYPOTHESIS_PHRASES: Record<HypothesisKey, string> = {
  // PATTERN：同一件事反复提到，规则说不出它是什么。
  LONG_TERM_INTEREST: '可能是你长期在意的事',
  STAGED_PROJECT: '可能是一个分几步推进的事',
  TEMPORARY_LEARNING: '可能只是这一阵子在看的东西',
  // GOAL_DRIFT：同一主题，目标的说法变了。
  GOAL_REPLACED: '可能目标真的换了',
  SAME_GOAL_NEW_PATH: '可能还是那个目标，只是换了路径',
  GOAL_NEVER_PINNED: '可能当初那个目标本来就没定死',
  // UNRESOLVED：提过，放着，没有下文。
  AWAITING_CONDITION: '可能还在等条件成熟',
  DECIDED_UNSPOKEN: '可能已经定了，只是没说出口',
  DEFERRING_IS_ANSWER: '可能拖着本身就是答案',
  // INTEREST_SHIFT：一个主题说得少了，另一个说得多了。
  NEW_TOOK_THE_PLACE: '可能新的占了旧的位子',
  BOTH_ORDER_CHANGED: '可能两样都在意，只是这阵子说到的顺序变了',
  OLD_PARKED_FOR_NOW: '可能旧的只是暂时搁下',
  // DECISION_LESSON：决定之后出现了结果，规则说不出是谁带来的。
  FROM_THIS_DECISION: '可能是这个决定带来的',
  FROM_SOMETHING_ELSE: '可能是同期另一件事带来的',
  ENVIRONMENT_ANYWAY: '可能和这个决定没关系，环境本来就会这样'
};

/**
 * 七类洞察的类型名只有 `reflection-display.ts` 那一份。
 *
 * 这里曾经有第二份，用途是给标题——于是标题就成了类型标签的复读，一屏三条 PATTERN
 * 摆出三行一模一样的「反复出现的主题」，最大的那号字什么也没说。类型标签的正当去处是
 * 卡片上那一枚 chip，不是标题；这份表删掉之后，同一个类型在全项目里只有一个名字。
 */

/**
 * 这条洞察的支持证据的原文（记忆正文 + 决策 topic，按 finding 里那两个数组的顺序）。
 *
 * 标题和正文共用这一份取材：正文引的是它的前几条，标题取它的最后一条——也就是最近那一句。
 * 取最近的那句是有理由的：这一屏回答的是「这件事现在长什么样」，而最早那一句往往已经被
 * 后面那句改过口（CONTRADICTION 那两类行摆在一起时尤其明显）。
 */
export function supportTextsOf(
  finding: ReflectionFinding,
  memoryTexts: ReadonlyMap<string, string>,
  decisionTopics: ReadonlyMap<string, string>
): string[] {
  return [
    ...finding.supportMemoryIds.map((id) => memoryTexts.get(id)),
    ...finding.supportDecisionIds.map((id) => decisionTopics.get(id))
  ].filter((text): text is string => typeof text === 'string' && text.trim() !== '');
}

/**
 * 一句原话压成标题。放得下就整句，放不下只留第一个分句——分句边界由 `CLAUSE_SPLIT_RE` 定，
 * 和决策抽取器用的是同一个，所以「一句完整的话」在这份仓库里只有一把尺子。
 * 第一个分句本身就超长时才按字数硬切，切完一定要带上截断标记。
 */
function asTitle(text: string): string {
  if (text.length <= REFLECTION_TITLE_MAX_CHARS) return `「${text}」`;
  const head = (text.split(CLAUSE_SPLIT_RE)[0] ?? text).trim();
  const inner =
    head.length <= REFLECTION_TITLE_MAX_CHARS ? head : [...head].slice(0, REFLECTION_TITLE_MAX_CHARS).join('');
  return `「${inner}${REFLECTION_TITLE_TRUNCATION_MARK}」`;
}

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
 * 分数 → 档位。单独成一个函数，因为**有两个调用方**：写侧在措辞前算一次（决定正文用哪句口气），
 * 读侧从库里那个分数再算一次（决定卡片上那颗 chip）。两条路必须落在同一个档，
 * 否则同一行会在生成时说「这几句说的是同一件事」、在屏幕上标成「把握小」。
 */
export function confidenceBandOf(score: number): ConfidenceBand {
  return score >= HIGH_BAND_MIN ? 'high' : score >= MEDIUM_BAND_MIN ? 'medium' : 'low';
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
  return { score: rounded, band: confidenceBandOf(rounded) };
}

/**
 * 一条洞察措辞完的样子：标题、正文、以及那一句只写一次的解释。
 * `alternatives` 是空串就等于「这一类没有备选解释可给」，界面那一行整个不留。
 */
export interface ReflectionDraft {
  title: string;
  body: string;
  alternatives: string;
}

/**
 * 把一条 finding 写成标题、正文和解释。
 *
 * 正文的顺序是固定的：口气 → 计数 → 原话 → （有反证）余地那一句。
 * 固定顺序才能让 critic 的「少了哪一段」变成字符串包含判断，也才能让同一条 finding 每次都得到同一个正文。
 *
 * 标题和解释都不在正文里，各有各的去处：标题走 `supportTextsOf` 的最后一条，解释走 `alternatives`。
 * 一句原话都拿不到时标题是空串——那不是「这条洞察没有标题」，而是「这一条不许落库」，
 * 挡下它的是 critic 的 TITLE_NOT_SOURCED（措辞层自己不判断，判断只有一个去处）。
 */
export function phraseReflection(input: PhrasingInput): ReflectionDraft {
  const { finding, band } = input;
  const sources = supportTextsOf(finding, input.memoryTexts, input.decisionTopics);
  const newest = sources[sources.length - 1];
  const parts: string[] = [FRAMING[band]];
  parts.push(`前后说过 ${finding.sampleCount} 次，跨度 ${finding.observationSpanDays} 天。`);

  if (sources.length > 0) {
    parts.push(`原话：${sources.slice(0, QUOTE_MAX).map((text) => `「${text}」`).join('、')}。`);
  }

  // 规则分不开解释时一条都不选：整类的几种一起给，让用户自己判——这是甲方案存在的全部理由。
  const phrases = finding.hypothesisKeys
    .map((key) => HYPOTHESIS_PHRASES[key as HypothesisKey])
    .filter((phrase): phrase is string => typeof phrase === 'string');

  if (input.counterHits > 0) parts.push(COUNTER_CLAUSE);

  return {
    title: newest === undefined ? '' : asTitle(newest),
    body: parts.join(''),
    alternatives: phrases.join('；')
  };
}

export type CriticReason =
  | 'GHOST_CITATION'
  | 'TITLE_NOT_SOURCED'
  | 'UNSOURCED_ASSERTION'
  | 'COUNTER_UNMENTIONED'
  | 'COUNT_MISMATCH'
  | 'HYPOTHESIS_DROPPED';

export interface CriticInput {
  finding: ReflectionFinding;
  draft: ReflectionDraft;
  counterHits: number;
  /** 这次扫描真正读到的行 id（记忆与决策都算）：引用不在里面就是凭空造的。 */
  poolIds: readonly string[];
  /**
   * 这条洞察的支持证据原文（`supportTextsOf` 的那一份）。
   * 标题要对着它核——措辞层和检查层如果各拿一份证据清单，两者迟早分叉，
   * 而分叉的方向正好是「标题引了一句不是这条洞察的话」。
   */
  supportTexts: readonly string[];
}

/**
 * 落库前的六道检查。任何一条命中都不写这一行——门槛 4、5 说的是「不许有无来源的断言」，
 * 那是一条写入规则，不是一个界面规则，所以它得长在写库之前。
 */
export function criticizeReflection(input: CriticInput): { accepted: boolean; reasons: CriticReason[] } {
  const { finding, draft, counterHits, poolIds } = input;
  const own = withoutQuotations(draft.body);
  const reasons: Set<CriticReason> = new Set();

  if (!titleIsSourced(draft.title, input.supportTexts)) reasons.add('TITLE_NOT_SOURCED');

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
 * 这个标题到底取自哪句话。
 *
 * 空标题、不带引号的标题、截掉后剩下的部分不是原话子串的标题，一律算「没取材」。
 * 截断标记可以先抹掉再比——那是措辞层加上的记号，不是用户说过的字，留着它反而永远对不上原文。
 */
function titleIsSourced(title: string, supportTexts: readonly string[]): boolean {
  if (!title.startsWith('「') || !title.endsWith('」')) return false;
  const inner = title
    .slice(1, -1)
    .replace(new RegExp(`${REFLECTION_TITLE_TRUNCATION_MARK}$`), '');
  if (inner === '') return false;
  return supportTexts.some((text) => text.includes(inner));
}

/**
 * 这个解释到底写没写进 `alternatives`。
 *
 * 认不出来的键（planner 将来加了新解释而措辞表没跟上）一律算「没写」：宁可这条洞察整条不落地，
 * 也不要它带着一个少了解释的正文落库——那正好是 6.3 禁止的那种「替用户断定」。
 * 只看 alternatives，不看正文：一句解释只有一个去处，抄在正文里第二遍不算写了它。
 */
function phrasesPresent(draft: ReflectionDraft, key: string): boolean {
  const phrase = HYPOTHESIS_PHRASES[key as HypothesisKey];
  if (phrase === undefined) return false;
  return draft.alternatives.includes(phrase);
}
