import { tokenize } from './retrieval';
import { splitSentences } from './decision-extractor';

/**
 * 结果陈述与决策的候选匹配（任务书 5.3 的第一版）。
 *
 * 两道闸：结果标记（结果/后来/最终…）+ 与某条已确认决策的主题至少一个共同词。
 * 第二道闸是这里最重要的决定：没有共同词就不连。把「结果项目黄了」连到一条买笔记本的
 * 决策上，是替用户做了一次没有依据的归因——5.3 明确禁止把结果好坏归到单一选择，
 * 词法版能做到的最低限度就是「连不上就不连」，连上的也只是候选（CANDIDATE），
 * 确认或解除由用户在界面上做。
 *
 * 共同词用 retrieval 的 tokenize（中文 bigram + 拉丁整词），和召回同一套切词口径，
 * 于是「这里连得上」和「读侧找得到」不会各说各话。
 *
 * 五列里 `actual` 是整句原话，另外四列（预期差异 / 遗漏因素 / 经验 / 评价）只在原话
 * 真说了它的时候才有值：认不出标记就留 null，绝不拿别处的话补一列空白。
 *
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-outcome-extractor.test.ts
 */
export const OUTCOME_CANDIDATES_PER_TURN = 2;

/** 结果的五列：`actual` 是整句，其余四列只装原话里能认出归属的那一段分句。 */
export type OutcomeFacet = 'gap' | 'missedFactors' | 'lesson' | 'rating';

export interface OutcomeMatch {
  decisionId: string;
  actual: string;
  gap: string | null;
  rating: string | null;
  missedFactors: string | null;
  lesson: string | null;
}

const OUTCOME_MARKERS: readonly string[] = [
  '结果',
  '后来',
  '最终',
  '最后',
  '实测',
  '用下来',
  '后悔',
  '幸好',
  '事实证明',
  '实际上'
];

/**
 * 分面词表。这里的顺序就是「一个分句只进一列」的裁决顺序：一个分句同时撞上两个标记时，
 * 排在前面的那列拿走整个分句，后面的列留空。所以「没想到下次还要这样」登记为遗漏因素，
 * 不再被当成经验——同一句话归到两列，等于替用户把一句话说成两件事。
 *
 * `比想象` 刻意不在 gap 里：它后面常接「中」（比想象中稳），而「想象中」不是预期，
 * 拿它填「预期差异」是在替用户造一个他没写过的对比。
 */
const FACETS: ReadonlyArray<{ field: OutcomeFacet; markers: readonly string[] }> = [
  { field: 'gap', markers: ['本来以为', '和预期', '跟预期', '预想', '出乎意料', '和想的', '跟想的'] },
  {
    field: 'missedFactors',
    markers: ['没想到', '没料到', '漏了', '忽略了', '没考虑', '少算', '当时没', '忘了考虑']
  },
  { field: 'lesson', markers: ['下次', '以后', '总结经验', '学到', '早知道', '教训'] },
  {
    field: 'rating',
    markers: ['后悔', '幸好', '不值', '满意', '失望', '真香', '上当', '坑', '亏了', '还行', '凑合', '靠谱', '好用', '难用']
  }
];

/** 分句边界：只切逗号、顿号、分号。句号以上交给 splitSentences，这里不重复切。 */
const CLAUSE_SPLIT_RE = /[，,、；;]/;

export function matchOutcomes(
  text: string,
  decisions: ReadonlyArray<{ id: string; topic: string }>
): OutcomeMatch[] {
  if (decisions.length === 0) return [];
  // 一个决策一轮只出一条：库里 (sourceMessageId, decisionId) 唯一，同一条决策的第二句
  // 若单独立一行会被 skipDuplicates 静默丢掉——那句话就此消失。所以后续句子并进同一条的分面。
  const groups = new Map<string, OutcomeMatch>();
  for (const piece of splitSentences(text)) {
    const sentence = piece.replace(/[。！？!?]+$/, '');
    if (!OUTCOME_MARKERS.some((marker) => sentence.includes(marker))) continue;
    const tokens = new Set(tokenize(sentence));
    if (tokens.size === 0) continue;
    const decision = decisions.find((candidate) =>
      tokenize(candidate.topic).some((token) => tokens.has(token))
    );
    if (!decision) continue;
    let candidate = groups.get(decision.id);
    if (!candidate) {
      // 名额满时不再立第三条决策，但仍然往下看——后面的句子可能并进已有那两条的分面。
      if (groups.size >= OUTCOME_CANDIDATES_PER_TURN) continue;
      candidate = {
        decisionId: decision.id,
        actual: sentence,
        gap: null,
        rating: null,
        missedFactors: null,
        lesson: null
      };
      groups.set(decision.id, candidate);
    }
    const group = candidate;
    for (const rawClause of sentence.split(CLAUSE_SPLIT_RE)) {
      const clause = rawClause.trim();
      if (!clause) continue;
      const claimed = FACETS.find(
        ({ field, markers }) => group[field] === null && markers.some((m) => clause.includes(m))
      );
      if (claimed) group[claimed.field] = clause;
    }
  }
  return [...groups.values()];
}
