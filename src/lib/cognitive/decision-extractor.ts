import type { DecisionCategory } from '@prisma/client';

/**
 * 决策候选的词法抽取（任务书 5.1 的第一版）。
 *
 * 和 memory-extractor 同一个哲学：宁可漏判。5.1 明确说「不能把普通聊天中的每个选择
 * 都当作重要决策」，而词法标记的错误方向天然是少抽——问句、偏好、闲聊一个都不碰。
 * 模型版抽取器要等「什么可以凌驾什么」的裁决，那片是架构决策，不在这片里偷做。
 *
 * 两层标记：类别标记是「动词 + 领域」（我决定用 / 我打算买），动词单独列出来是因为
 * 选择内容要取动词之后的部分——「我决定用 X」里被决定的是「用 X」，不是「我决定」。
 *
 * v1 不分离主题与选择：topic 与 choice 同值。任务书 5.2 的其余列（背景/约束/可选方案/
 * 理由/标准/预期/风险）在词法下没有可靠来源，留空比编造好。
 *
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-decision-extractor.test.ts
 */
export const DECISION_CANDIDATE_MIN_CHARS = 4;
export const DECISION_CANDIDATE_MAX_CHARS = 200;
export const DECISION_CANDIDATES_PER_TURN = 2;

export interface DecisionCandidate {
  category: DecisionCategory;
  topic: string;
  choice: string;
}

/** 顺序即优先级：一句话同时命中两类时，靠前的类别赢。 */
const CATEGORY_MARKERS: ReadonlyArray<{ category: DecisionCategory; markers: readonly string[] }> = [
  { category: 'TECH_CHOICE', markers: ['我决定用', '我选了', '我改用', '我敲定用', '我拍板用'] },
  { category: 'PROJECT_PLANNING', markers: ['我准备启动', '我打算立项', '我计划做', '项目排期'] },
  { category: 'CAREER', markers: ['我打算跳槽', '我决定离职', '我接受 offer', '我准备转岗', '我选择加入'] },
  { category: 'LEARNING', markers: ['我打算学', '我计划考', '我准备学', '我开始学', '我报了这个课'] },
  { category: 'PURCHASE', markers: ['我决定买', '我打算买', '我准备入手', '我下单了', '我买了'] },
  { category: 'PERSONAL_GOAL', markers: ['我的目标是', '我打算以后', '我计划今年', '我要在年内'] }
];

const VERBS: readonly string[] = [
  '我的目标是',
  '我决定',
  '我选了',
  '我敲定',
  '我拍板',
  '我打算',
  '我计划',
  '我准备',
  '我下单了',
  '我买了',
  '我改用',
  '我开始',
  '我报了',
  '我接受',
  '我选择'
];

/** 保留句尾标点地切句；问句整句不算决策候选。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?\n])/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0 && !piece.endsWith('？') && !piece.endsWith('?'));
}

function verbOf(marker: string): string {
  return VERBS.find((verb) => marker.startsWith(verb)) ?? marker;
}

export function extractDecisionCandidates(text: string): DecisionCandidate[] {
  const candidates: DecisionCandidate[] = [];
  for (const piece of splitSentences(text)) {
    const sentence = piece.replace(/[。！？!?]+$/, '');
    let hit: { category: DecisionCategory; index: number; verb: string } | null = null;
    for (const { category, markers } of CATEGORY_MARKERS) {
      for (const marker of markers) {
        const index = sentence.indexOf(marker);
        if (index === -1) continue;
        if (hit === null || index < hit.index) {
          hit = { category, index, verb: verbOf(marker) };
        }
      }
    }
    if (hit === null) continue;
    const choice = sentence.slice(hit.index + hit.verb.length).trim();
    if (choice.length < DECISION_CANDIDATE_MIN_CHARS) continue;
    candidates.push({
      category: hit.category,
      topic: choice.slice(0, DECISION_CANDIDATE_MAX_CHARS),
      choice: choice.slice(0, DECISION_CANDIDATE_MAX_CHARS)
    });
    if (candidates.length >= DECISION_CANDIDATES_PER_TURN) break;
  }
  return candidates;
}
