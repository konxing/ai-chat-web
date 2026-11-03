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
 * 向量、图扩展、Reranker、RRF 都不在这里：向量要独立的 Embedding Provider 配置，
 * 图扩展要 MemoryRelation 表，两样都还不存在（任务书 3.4）。
 * 顺带一句：想用这里的词法分数直接生成 RELATED_TO 边已经试过并且否掉了，
 * 实测数据和不成立的理由写在 tests/unit/cognitive-relations-calibration.test.ts。
 *
 * 纯函数，不碰数据库。测试：tests/unit/cognitive-retrieval.test.ts、
 * 与时间序基线的对照在 tests/unit/cognitive-retrieval-eval.test.ts。
 */

/** 连续拉丁/数字算一个词；连续汉字整段取出来再切 bigram。 */
const TOKEN_PATTERN = /[a-z0-9]+|[㐀-䶿一-鿿豈-﫿]+/g;

export interface Retrievable {
  content: string;
  /** ISO 字符串：同分时按它倒序，新的在前。 */
  recordedAt: string;
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

  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return memories.slice(0, limit);

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

  return scored.slice(0, limit).map((entry) => entry.memory);
}
