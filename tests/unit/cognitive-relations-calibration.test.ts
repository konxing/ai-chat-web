import { describe, expect, it } from 'vitest';
import { tokenize } from '@/lib/cognitive/retrieval';

/**
 * RELATED_TO 的阈值校准（任务书 2.3 要求 MemoryRelation；这一片卡在这一步）。
 *
 * 结论：**词法相关度分不出「同一件事」和「同一个句式」，所以 RELATED_TO 边一条都不生成，
 * MemoryRelation 表也先不建。** 这个文件把那个测量钉住，防止以后有人随手设个 0.35 就把它上线。
 *
 * 打分器写在测试里而不是 src 里：它没有生产调用方。留一份没人用的算法在检索模块里，
 * 和我在「记忆策略」屏上删掉的那些假开关是同一种东西。
 *
 * 测的是两类配对在 55 行池子里的分数：
 * - 句式重叠：「我把X洗了一遍」「我最近在X」这种同一框架、不同宾语的对。它们不该连边。
 *   45 组里有 20 组拿到分，区间 0.262 ～ 0.481。
 * - 主题重叠：共享一个真实词组（数据库 / 所有权 / 青霉素 / 自建机房 / 小提琴 / 后端）的对。它们该连边。
 *   6 组全部拿到分，区间 0.192 ～ 0.412。
 * 两个区间互相盖住：最强的句式对比方最强的主题分高，最弱的句式对也比最弱的主题分高，
 * 所以下面那条扫描断言在 0.00～1.00 里找不到一个能分开的阈值。
 *
 * 为什么 IDF 救不了：句式一旦成组出现，共享的是三个连续词（我最/最近/近在），而罕见实体只共享两个
 * （青霉/霉素）——三份低权重加起来仍然比两份大。分母又取较短那条的总质量，短句天然占便宜。
 * 这不是调参能修的，是词法的天花板：要分出语义得靠 Embedding（任务书 3.1 的向量候选），
 * 或者靠一份人工标注的评测集（7.1 的 30 个故事），两样都还没有。
 *
 * 任务书 2.3 那八种关系里，今天只有一种有诚实的产生路径：EVOLVES_FROM。
 * 而它已经存在 MemoryRevision 里（memoryId + previousId + 加密的理由 + 来源消息），
 * 再建一张表把同一条边存第二份，只是多一处可能不一致的地方，所以这张表不建。
 */

const FRAMES = [
  '我把桌面收拾了一遍',
  '我把衣服洗了一遍',
  '我把屋子打扫了一遍',
  '我把地板拖了一遍',
  '我把碗筷洗了一遍',
  '我最近在练吉他',
  '我最近在写代码',
  '我最近在学英语',
  '我最近在减肥',
  '我最近在读历史'
];

const FILLERS = [
  '今天开了个例会',
  '午饭吃的面条',
  '这周下雨了三天',
  '周末睡了个懒觉',
  '地铁上人多得离谱',
  '我换了一个新杯子',
  '晚上看了部电影',
  '快递昨天到了',
  '阳台的花该浇水了',
  '楼下新开了一家便利店',
  '手机屏幕摔裂了',
  '牙刷该换成电动的',
  '小区停车位又满了',
  '冰箱需要除霜了',
  '体检报告说血脂偏高',
  '把客厅的灯换成暖光',
  '周末去爬山腿疼了两天',
  '咖啡喝多了睡不着',
  '新买的鞋子有点磨脚',
  '水龙头滴水一直没修',
  '这本书买了三年还没拆封',
  '办公室空调太吵',
  '每年春天都过敏',
  '晚上九点后不吃饭',
  '办了张健身卡去了两次',
  '键盘的空格键松了',
  '头发该剪了',
  '地铁卡余额不足',
  '厨房的油烟该机清洗',
  '阳台晒不下被子',
  '车窗上有道裂纹',
  '睡落枕了脖子疼',
  '这个月水电费涨了不少',
  '牙膏快用完了',
  '桌子腿上垫了张纸',
  '门铃电池没电',
  '上楼梯膝盖响',
  '手机存储空间满了',
  '雨天开车视线差',
  '枕头太高不舒服',
  '洗衣机滤网老堵',
  '窗户缝里进灰',
  '眼睛干涩得厉害',
  '指甲长得太快',
  '水壶里水垢厚了'
];

/** 人眼看着确实是同一件事的配对：共享的都是实词词组。 */
const TOPIC_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['我在用 Prisma 做澄境的数据库层', '澄境项目的数据库还没定'],
  ['我最近在学 Rust 的所有权', 'Rust 所有权规则真绕'],
  ['我对青霉素过敏', '青霉素不能给我用'],
  ['当初考虑过自建机房', '自建机房的成本太高了'],
  ['我小时候学过小提琴', '小提琴的谱子看不懂'],
  ['老周是负责后端的同事', '后端那块的负责人换了人']
];

const POOL = [...FRAMES, ...FILLERS];

/** 和读侧检索同一套切词和 IDF 口径；池子里每条文本只算一次，重复的说法不额外抬词频。 */
const MIN_TOKENS = 3;
const MIN_SHARED_TOKENS = 2;

function weight(token: string, total: number, documentFrequency: Map<string, number>): number {
  const hits = documentFrequency.get(token) ?? 0;
  return Math.log(1 + total / (hits === 0 ? 1 : hits));
}

function mass(tokens: ReadonlySet<string>, total: number, documentFrequency: Map<string, number>): number {
  let sum = 0;
  for (const token of tokens) sum += weight(token, total, documentFrequency);
  return sum;
}

/** 两条记忆在整池记忆面前的词法相关度：共享词的 IDF 质量占较短那条总质量的比例。 */
function relatedScore(source: string, other: string, pool: readonly string[]): number {
  const texts = [...new Set([source, other, ...pool])];
  const documents = texts.map((text) => new Set(tokenize(text)));
  const sourceTokens = documents[0]!;
  const otherTokens = documents[1]!;
  if (sourceTokens.size < MIN_TOKENS || otherTokens.size < MIN_TOKENS) return 0;

  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of document) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const total = documents.length;

  let shared = 0;
  let numerator = 0;
  for (const token of sourceTokens) {
    if (!otherTokens.has(token)) continue;
    shared += 1;
    numerator += weight(token, total, documentFrequency);
  }
  if (shared < MIN_SHARED_TOKENS) return 0;
  const denominator = Math.min(mass(sourceTokens, total, documentFrequency), mass(otherTokens, total, documentFrequency));
  return denominator === 0 ? 0 : numerator / denominator;
}

/** 句式配对的全体：同一池子里任意两句「我把X」「我最近在Y」的组合。 */
const FRAME_PAIRS: Array<readonly [string, string]> = [];
for (let i = 0; i < FRAMES.length; i += 1) {
  for (let j = i + 1; j < FRAMES.length; j += 1) FRAME_PAIRS.push([FRAMES[i]!, FRAMES[j]!]);
}

const scored = (pairs: ReadonlyArray<readonly [string, string]>): number[] =>
  pairs.map(([left, right]) => relatedScore(left, right, POOL)).filter((value) => value > 0);

const frames = scored(FRAME_PAIRS);
const topics = scored(TOPIC_PAIRS);

describe('RELATED_TO 阈值校准：词法分不出句式重叠和主题重叠', () => {
  it('句式配对能被打出可观的分数——不是零分，也就不是「本来就分得开」', () => {
    // 45 个句式组合里有 20 组过得了结构下限拿到分；剩下的是「我把X」配「我最近在Y」这种不同框架。
    expect(frames.length).toBeGreaterThanOrEqual(20);
    expect(Math.min(...frames)).toBeGreaterThanOrEqual(0.26);
  });

  it('最强的句式对比最强的主题对分数还高', () => {
    expect(Math.max(...frames)).toBeGreaterThan(Math.max(...topics));
  });

  it('最弱的句式对比最弱的主题对分数还高：共享一个罕见实体反而比共享一个框架得分少', () => {
    expect(Math.min(...frames)).toBeGreaterThan(Math.min(...topics));
  });

  it('0.00～1.00 扫一遍都不存在能把两类分开的阈值', () => {
    const separable: number[] = [];
    for (let threshold = 0; threshold <= 1; threshold += 0.01) {
      const keepsEveryTopic = topics.every((value) => value >= threshold);
      const rejectsEveryFrame = frames.every((value) => value < threshold);
      if (keepsEveryTopic && rejectsEveryFrame) separable.push(Number(threshold.toFixed(2)));
    }
    expect(separable).toEqual([]);
  });

  it('这个对照不是空跑：同一组句式打出来的分比罕见实体那组高', () => {
    const frame = relatedScore('我最近在练吉他', '我最近在减肥', POOL);
    const entity = relatedScore('我对青霉素过敏', '青霉素不能给我用', POOL);
    expect(frame).toBeGreaterThan(entity);
  });

  it('共享的都是实词，也照样排在所有句式对后面', () => {
    // 「后端」「负责」两个都是实词，可这两句话只共享两个词；
    // 「我最近在X」共享的是三个连续词。数量决定分数，词的意义不参与——这就是词法的天花板。
    const weakTopic = relatedScore('老周是负责后端的同事', '后端那块的负责人换了人', POOL);
    expect(weakTopic).toBeLessThan(Math.min(...frames));
  });

  it('两类分数的实际区间——上面那些结论用的就是这串数', () => {
    expect(Math.min(...topics)).toBeGreaterThanOrEqual(0.19);
    expect(Math.max(...topics)).toBeLessThanOrEqual(0.42);
    expect(Math.max(...frames)).toBeLessThanOrEqual(0.49);
  });
});
