/**
 * 关键词召回（Phase 3 的第一块砖）。
 *
 * 此前的读侧是按 recordedAt 倒序取前 8 条，和用户这一轮问什么完全无关——
 * 那不是检索，是「最近说过什么」。这里换成按重合度排序。
 *
 * 正文是密文，SQL 层看不到明文，所以匹配只能在应用层解密之后做（任务书 5.3 认了这条路）。
 * 代价是候选池必须整个捞回来解密，池子大小由 memory-module 的 MEMORY_RETRIEVAL_POOL 决定。
 *
 * 中文没有词边界，所以按 bigram 切；英文和数字按整词切。
 * 评分是「IDF 加权的查询覆盖率」：命中的词越罕见，贡献越大。
 * 不做 IDF 的话，「我在」「我的」这种到处都有的词会把每条记忆的分数一起抬起来，
 * 排序就退化成时间顺序了。
 *
 * 向量这一路（5d）只做余弦和 RRF 混合，两个函数都是纯的：向量由调用方给。
 * 读侧带不带查询向量是 memory-module 的闸门问题——把向量解密和查询 embedding 塞进这里，
 * 这个文件就得碰数据库和出站，评测 Harness 也就调不动它了。
 * 图扩展仍然不在：它要 MemoryRelation 表，实测和理由写在
 * tests/unit/cognitive-relations-calibration.test.ts。
 *
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-retrieval.test.ts、
 * 与时间序基线的对照在 tests/unit/cognitive-retrieval-eval.test.ts。
 */

/** 连续拉丁/数字算一个词；连续汉字整段取出来再切 bigram。 */
const TOKEN_PATTERN = /[a-z0-9]+|[㐀-䶿一-鿿豈-﫿]+/g;

/** 余弦那一路的名次融合常数：RRF 论文里的默认值，不打算调——没有数据支撑一个别的数。 */
const RRF_K = 60;

export interface Retrievable {
  content: string;
  /** ISO 字符串：同分时按它倒序，新的在前。 */
  recordedAt: string;
}

/** 存下来的向量解出来后就是普通数字，测试里直接写数组也接得住。 */
export type NumericVector = readonly number[] | Float32Array;

export interface Vectorizable extends Retrievable {
  /** 这一行还没算过向量就是 undefined/null；混合排序不会替它编一个。 */
  vector?: NumericVector | null;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    const piece = match[0];
    if (/[a-z0-9]/.test(piece[0]!)) {
      tokens.push(piece);
      continue;
    }
    // 单个汉字也要留下：只切 bigram 的话，「猫」这种一字查询一个 token 都切不出来。
    if (piece.length === 1) tokens.push(piece);
    else for (let index = 0; index < piece.length - 1; index += 1) tokens.push(piece.slice(index, index + 2));
  }
  return tokens;
}

function weight(token: string, total: number, documentFrequency: Map<string, number>): number {
  const hits = documentFrequency.get(token) ?? 0;
  // 池子里一条都没有的词按最罕见算：它永远进不了分子，但留在分母里，
  // 免得一个问题只要带个生僻词，就把随便哪条记忆的分数抬满。
  return Math.log(1 + total / (hits === 0 ? 1 : hits));
}

/**
 * 按与查询的相关度排序，取前 limit 条。
 *
 * 一个相关项都没命中时（分数全 0），稳定的排序会原样保留传入顺序，
 * 而传入顺序就是 recordedAt 倒序——也就是说退化行为等于改造前的行为，不会比现状更差。
 * 部分命中时，剩下的名额同样由最近的补上：宁可多给一条不那么相关的，
 * 也不要因为「不够相关」就让用户这一轮完全没有记忆可用。
 */
export function rankMemories<T extends Retrievable>(
  query: string,
  memories: readonly T[],
  options: { limit?: number } = {}
): T[] {
  const limit = options.limit ?? memories.length;
  if (memories.length === 0 || limit <= 0) return [];

  return scoreByKeyword(query, memories).slice(0, limit).map((entry) => entry.memory);
}

/** 关键词打分 + 排序，一整池返回（不截断）——rankMemories 和混合排序共用这一份口径。 */
export function scoreByKeyword<T extends Retrievable>(
  query: string,
  memories: readonly T[]
): Array<{ memory: T; score: number }> {
  const queryTokens = [...new Set(tokenize(query))];
  // 切不出词时原样返回、一个分数也不给：这就是改造前的时间倒序，
  // 排序在这里没有可说的话。
  if (queryTokens.length === 0) return memories.map((memory) => ({ memory, score: 0 }));

  const documents = memories.map((memory) => new Set(tokenize(memory.content)));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of document) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }

  const total = memories.length;
  let denominator = 0;
  const weights = new Map<string, number>();
  for (const token of queryTokens) {
    const value = weight(token, total, documentFrequency);
    weights.set(token, value);
    denominator += value;
  }

  const scored = memories.map((memory, index) => {
    if (denominator === 0) return { memory, score: 0 };
    let numerator = 0;
    for (const token of queryTokens) {
      if (documents[index]!.has(token)) numerator += weights.get(token)!;
    }
    return { memory, score: numerator / denominator };
  });

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    // 同分按时间倒序：listMemories 给的就是这个顺序，这里显式再排一次，
    // 免得「排序结果依赖调用方传进来的顺序」变成一条没人看得见的隐含约定。
    return right.memory.recordedAt.localeCompare(left.memory.recordedAt);
  });

  return scored;
}

/**
 * 余弦。维度不同或谁模长为 0 一律给 0，不给 NaN。
 *
 * NaN 会顺着排序比较器把顺序变成「看引擎心情」：Array.sort 遇到 NaN 返回值时
 * 不做交换，整池退化成传入顺序，而这和传进来什么数组有关。
 */
export function cosine(left: NumericVector, right: NumericVector): number {
  const length = left.length;
  if (length === 0 || right.length !== length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    // 向量是从密文解出来再 unpack 的，理论上不会有 NaN/Infinity；真出现了就当不相关，
    // 不能让一个坏分量把整池排序带走。
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * 只按余弦排序：带向量的在前，没算过向量的原样跟在后面。
 *
 * 一条都不丢：这一路没有话说时不该让行凭空消失，后面的混合排序还要靠它兜底。
 */
export function rankByCosine<T extends Vectorizable>(
  queryVector: NumericVector,
  memories: readonly T[],
  options: { limit?: number } = {}
): T[] {
  const limit = options.limit ?? memories.length;
  if (memories.length === 0 || limit <= 0) return [];

  return sortByCosine(queryVector, memories)
    .slice(0, limit)
    .map((entry) => entry.memory);
}

/** 余弦排序，一整池返回；score 为 null 表示这一行没有向量。 */
function sortByCosine<T extends Vectorizable>(
  queryVector: NumericVector,
  memories: readonly T[]
): Array<{ memory: T; score: number | null }> {
  const scored = memories.map((memory) => ({
    memory,
    score: memory.vector == null ? null : cosine(queryVector, memory.vector)
  }));

  scored.sort((left, right) => {
    if ((left.score === null) !== (right.score === null)) return left.score === null ? 1 : -1;
    if (left.score !== null && right.score !== null && left.score !== right.score) {
      return right.score - left.score;
    }
    return right.memory.recordedAt.localeCompare(left.memory.recordedAt);
  });

  return scored;
}

/**
 * 关键词 ⊕ 余弦的 RRF 混合排序（k = 60）。
 *
 * 两路分数不在一个量纲上（一边是 0..1 的覆盖率，一边是 -1..1 的夹角），
 * 所以只比名次不比分数：每路给 `1 / (60 + 名次)`，两路相加。
 *
 * 关键词这一路只给 0 分以上的行记名次。这是这函数唯一不显然的地方：
 * 「一个词都没重合」在关键词眼里是「没话说」，不是「排在第 200 名」——
 * 按后者算，最近那条废话会稳定拿到最好的名次，把向量想救的那批
 * （零共享 token 的 gold）原地压死。实测那 44 条未召回的 gold 全靠这一条才进得来。
 *
 * 不传查询向量时逐字节退回 rankMemories：今天的读侧只有关键词那一路，
 * 混合不许在没被打开的情况下改变任何结果。
 */
export function rankMemoriesHybrid<T extends Vectorizable>(
  query: string,
  queryVector: NumericVector | null | undefined,
  memories: readonly T[],
  options: { limit?: number } = {}
): T[] {
  const limit = options.limit ?? memories.length;
  if (memories.length === 0 || limit <= 0) return [];
  if (queryVector == null) return rankMemories(query, memories, { limit });

  const keywordRanks = new Map<T, number>();
  scoreByKeyword(query, memories).forEach((entry, index) => {
    if (entry.score > 0) keywordRanks.set(entry.memory, index);
  });

  const cosineRanks = new Map<T, number>();
  sortByCosine(queryVector, memories).forEach((entry, index) => {
    if (entry.score !== null) cosineRanks.set(entry.memory, index);
  });

  const fused = memories.map((memory) => {
    const keywordRank = keywordRanks.get(memory);
    const cosineRank = cosineRanks.get(memory);
    let score = 0;
    if (keywordRank !== undefined) score += 1 / (RRF_K + keywordRank + 1);
    if (cosineRank !== undefined) score += 1 / (RRF_K + cosineRank + 1);
    return { memory, score };
  });

  fused.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return right.memory.recordedAt.localeCompare(left.memory.recordedAt);
  });

  return fused.slice(0, limit).map((entry) => entry.memory);
}
