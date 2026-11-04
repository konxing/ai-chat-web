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
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-outcome-extractor.test.ts
 */
export const OUTCOME_CANDIDATES_PER_TURN = 2;

export interface OutcomeMatch {
  decisionId: string;
  actual: string;
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

export function matchOutcomes(
  text: string,
  decisions: ReadonlyArray<{ id: string; topic: string }>
): OutcomeMatch[] {
  if (decisions.length === 0) return [];
  const matches: OutcomeMatch[] = [];
  for (const piece of splitSentences(text)) {
    const sentence = piece.replace(/[。！？!?]+$/, '');
    if (!OUTCOME_MARKERS.some((marker) => sentence.includes(marker))) continue;
    const tokens = new Set(tokenize(sentence));
    if (tokens.size === 0) continue;
    for (const decision of decisions) {
      const shared = tokenize(decision.topic).some((token) => tokens.has(token));
      if (!shared) continue;
      matches.push({ decisionId: decision.id, actual: sentence });
      break;
    }
    if (matches.length >= OUTCOME_CANDIDATES_PER_TURN) break;
  }
  return matches;
}
