import type { DecisionCategory } from '@prisma/client';
import { hasReviewSchedule } from './review-schedule';

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
 * v1 不分离主题与选择：topic 与 choice 同值。任务书 5.2 的其余列里，只有「预期结果」
 * 在词法上有可靠来源（同一句里的预期分句，见下面 EXPECTATION_MARKERS）；
 * 背景/约束/可选方案/理由/标准/风险六列仍然没有——那些话不在这一句里，留空比编造好。
 *
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-decision-extractor.test.ts
 */
export const DECISION_CANDIDATE_MIN_CHARS = 4;
export const DECISION_CANDIDATE_MAX_CHARS = 200;
export const DECISION_CANDIDATES_PER_TURN = 2;

/**
 * 分句边界：只切逗号、顿号、分号。句号以上由 `splitSentences` 负责，这里不重复切。
 * `outcome-extractor` 共用同一个形状，两处的「一句只归一段」才是同一件事。
 */
export const CLAUSE_SPLIT_RE = /[，,、；;]/;

export interface DecisionCandidate {
  category: DecisionCategory;
  topic: string;
  choice: string;
  /** 同一句里的预期分句原话；没说就是 null，不从「我决定」推断出一个预期。 */
  expectedOutcome: string | null;
  /**
   * 这句话的原话（句尾标点已剥）。写侧拿它算 `reviewAfter`——复盘时间必须来自
   * 决策自己那一句，不能从同一段聊天的别处借。候选行不落库，所以这一列只活在内存里。
   */
  sourceSentence: string;
}

/**
 * 预期结果的标记。刻意不含「我想」「准备」这类既表意图又表期望的说法：
 * 「我想着先跑半年再说」里的「想着」不是预期结果，登记进去就是把语气当成了内容。
 *
 * 带时长说法的分句（「预计三个月后再看一次」）**不算预期**：那是一句安排，不是一个结果，
 * 让 reviewAfter 那一列去接它（`hasReviewSchedule` 就是为这条界线导出的）。
 */
const EXPECTATION_MARKERS: readonly string[] = [
  '我预期',
  '我预计',
  '预计',
  '本来想',
  '我以为',
  '希望能',
  '我希望',
  '指望'
];

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

/**
 * 明确决策动词的兜底：「我决定了，接受杭州那份工作 offer」这种「动词 + 逗号 + 选择」的自然说法，
 * 领域标记（我接受 offer / 我决定离职）接不住，但「我决定了」本身就是一个拍板信号。
 * 只收带「了」的完成态——「我决定今天吃什么」这种随口选择不算重要决策（5.1 的红线）。
 * 命中后按句子里的领域关键词归类，归不出来落到 PERSONAL_GOAL。
 */
const GENERIC_DECISION_VERB = '我决定了';

const DOMAIN_KEYWORDS: ReadonlyArray<{ category: DecisionCategory; keywords: readonly string[] }> = [
  { category: 'CAREER', keywords: ['offer', '工作', '跳槽', '离职', '辞职', '入职', '转岗', '加入'] },
  { category: 'PURCHASE', keywords: ['买', '入手', '下单', '购买', '预算'] },
  { category: 'LEARNING', keywords: ['学', '考', '课程', '报班', '考研'] },
  { category: 'TECH_CHOICE', keywords: ['框架', '技术', '数据库', '语言', '栈', '改用'] },
  { category: 'PROJECT_PLANNING', keywords: ['项目', '立项', '启动', '排期'] }
];

function categoryOfSentence(sentence: string): DecisionCategory {
  for (const { category, keywords } of DOMAIN_KEYWORDS) {
    if (keywords.some((keyword) => sentence.includes(keyword))) return category;
  }
  return 'PERSONAL_GOAL';
}

/** 保留句尾标点地切句；问句整句不算决策候选。 */
export function splitSentences(text: string): string[] {
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
    if (hit === null) {
      // 领域标记没命中，但句子里有明确决策动词：按领域关键词归类后照常取选择内容。
      const index = sentence.indexOf(GENERIC_DECISION_VERB);
      if (index === -1) continue;
      hit = { category: categoryOfSentence(sentence), index, verb: GENERIC_DECISION_VERB };
    }
    const remainder = sentence.slice(hit.index + hit.verb.length);
    const clauses = remainder
      .split(CLAUSE_SPLIT_RE)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
    const expectedOutcome =
      clauses.find(
        (clause) =>
          EXPECTATION_MARKERS.some((marker) => clause.includes(marker)) && !hasReviewSchedule(clause)
      ) ?? null;
    // 一句话说过的内容只归一列：预期分句已经进了 expectedOutcome，就不该再混在「用户选择」里
    // 显示第二遍。剩下的分句按「，」重接——分句边界本来只在这里有意义。
    const choice = clauses
      .filter((clause) => clause !== expectedOutcome)
      .join('，')
      .slice(0, DECISION_CANDIDATE_MAX_CHARS);
    if (choice.length < DECISION_CANDIDATE_MIN_CHARS) continue;
    candidates.push({
      category: hit.category,
      topic: choice,
      choice,
      expectedOutcome,
      sourceSentence: sentence
    });
    if (candidates.length >= DECISION_CANDIDATES_PER_TURN) break;
  }
  return candidates;
}
