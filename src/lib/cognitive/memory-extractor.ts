import type { MemoryType } from './policy';

/**
 * 规则抽取（任务书 Phase 2 的 MemoryExtractor 第一版）。
 *
 * 用途：把用户亲口陈述的话切成候选记忆，并给出记忆类型，交给写入决策去判要不要留。
 * 输入：用户这一轮消息的原文（绝不包含模型回复）。输出：`[{ text, type }]`，顺序按原文。
 * 测试：tests/unit/cognitive-memory-extractor.test.ts
 *
 * 为什么先不用模型：这个结果决定「要不要把内容写进长期库」，词法表可以逐词解释、可以进评测集比对，
 * 出错时能找到是哪个词惹的。问句、转述、长段落一律不抽，宁可少记。
 *
 * 情绪句是 11-06 片U 才接上的一条：改造前这里只有五种类型，头注释写着「情绪句不在这里抽（那是情感引擎的活）」，
 * 而偏好表里的 `emotionEnabled` 因为这条链上没有生产者，也一直没有人读。今天它抽的是**用户原话整句**——
 * 系统不给情绪下判断，也不给情绪命名（任务书 :430），只做一件事：把这一句按情绪类存下来。
 * 而且它同时受两道闸：`emotionEnabled` 不开就一个词都不比，开了还要该情境的策略把 emotion 列进
 * 允许类型（七个情境的默认值都没有，见 `policy.ts`），才会真的落库。
 */
export const MEMORY_CANDIDATE_MIN_CHARS = 4;
export const MEMORY_CANDIDATE_MAX_CHARS = 200;
export const MEMORY_CANDIDATES_PER_TURN = 3;

/** 顺序即优先级：一句话同时像「决策」和「目标」时，按决策处理。 */
const RULES: ReadonlyArray<{ type: MemoryType; markers: readonly string[] }> = [
  { type: 'decision', markers: ['我决定', '我定了', '我选了', '我敲定', '我拍板'] },
  {
    type: 'project',
    markers: [
      '我在用',
      '我用的是',
      '我正在做',
      '我在做',
      '我负责',
      '我维护',
      '我接手',
      '我的项目',
      '我们项目',
      '用的是',
      '换成了',
      '迁移到'
    ]
  },
  { type: 'goal', markers: ['我打算', '我计划', '我准备', '我想', '我要', '我的目标是', '目标是', '以后要'] },
  { type: 'preference', markers: ['我喜欢', '我不喜欢', '我讨厌', '我习惯', '我不爱', '我偏好', '我爱', '我每天', '我现在每天'] },
  {
    type: 'fact',
    markers: ['我叫', '名字是', '我今年', '我住在', '我搬到', '我的生日', '我家在', '我有', '我没有', '我养了', '我养']
  }
];

/**
 * 情绪类候选的词表，只在 `emotionEnabled` 打开时才比对（片U）。
 *
 * 三个约束是这张表之所以只有这几个词的理由：
 * 一、只收**第一人称的说法**。整句还额外要求含「我」且不是问句（下面 `extractMemoryCandidates`），
 *     所以「她心里很难受」「我很烦吗」都不算。落库的是用户那句话，不是系统对情绪的命名或判断。
 * 二、不收临床词。「抑郁」「焦虑症」这类不在表里——系统没有资格给用户贴诊断，
 *     而用户自己说出来的那些字仍然会被整句存下来，那是他的说法，不是我们的结论。
 * 三、比 `RULES` 更早。一句话同时像感受和偏好时先当感受处理：
 *     把「我不喜欢现在的自己，我心里难受」标成 preference，等于把一句倾诉存成一条口味记录。
 */
const EMOTION_MARKERS: readonly string[] = [
  '心里难受',
  '心里烦',
  '很烦',
  '好烦',
  '烦死',
  '堵得慌',
  '喘不过气',
  '想哭',
  '哭了',
  '失眠',
  '睡不着',
  '压力大',
  '压力好大',
  '压力太大',
  '很委屈',
  '好委屈',
  '情绪很低',
  '情绪低落',
  '心情很差',
  '心情不好',
  '提不起劲',
  '撑不住',
  '绷不住',
  '孤独'
];

/** 只在句末标点处切：ASCII 句点留给「Next.js」「1.5」这类写法，不然技术句子会被剁碎。 */
const SENTENCE_SPLIT = /[。；;\n]+|[!?！？]+/;

/** 疑问句、疑问词结尾的句子一律不算陈述。问「我的项目怎么部署」不是在告诉我一个项目事实。 */
// 句末的 ？/！ 会被 SENTENCE_SPLIT 当分隔符吃掉，所以疑问词必须能拦住「我喜欢喝什么样的咖啡」这类
// 只剩疑问代词收尾的句子；「我什么都没说」不以「什么」收尾，不受影响。
const QUESTION_MARK = /[?？]|怎么|如何|为什么|什么样|怎样|哪里|哪儿|多少|什么\s*$|[吗呢]\s*$/;

export interface MemoryCandidate {
  text: string;
  type: MemoryType;
  /**
   * 只有 AI 记忆审核会填：这句是用户对某条已有记忆的改口，审核模型点名要推翻那一行的 id。
   * 规则层永远留空——词表判不出「说的是同一件事的新说法」，那种判断本来就是模型的活。
   */
  supersedesId?: string;
}

export interface ExtractOptions {
  /** 情绪总开关。缺席（undefined）按关处理：调用方没走引擎时，就不该抽出一类它没打算处理的候选。 */
  emotionEnabled?: boolean;
}

function classifySentence(sentence: string, emotionEnabled: boolean): MemoryType | null {
  if (emotionEnabled && EMOTION_MARKERS.some((marker) => sentence.includes(marker))) return 'emotion';
  for (const rule of RULES) {
    if (rule.markers.some((marker) => sentence.includes(marker))) return rule.type;
  }
  return null;
}

export function extractMemoryCandidates(content: string, options: ExtractOptions = {}): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(SENTENCE_SPLIT)) {
    if (candidates.length >= MEMORY_CANDIDATES_PER_TURN) break;
    const text = raw.trim();
    if (text.length < MEMORY_CANDIDATE_MIN_CHARS || text.length > MEMORY_CANDIDATE_MAX_CHARS) continue;
    if (!text.includes('我') || QUESTION_MARK.test(text)) continue;
    const type = classifySentence(text, options.emotionEnabled === true);
    if (!type) continue;
    const key = text.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text, type });
  }
  return candidates;
}

/**
 * 用户直接命令系统「记下来」的那些句子。
 *
 * 为什么单独一条链：这类话是**指令**，不是「值得不值得记」的判断题。开了 AI 记忆审核之后，
 * 审核模型有权否掉它认为一次性的说法，但它无权否掉用户当面下的命令——「记住我不吃香菜」
 * 被哪条 AI 判成临时信息都是错的。所以这些句子走审核之外的路，直接进候选。
 *
 * 只认句首的命令式前缀 + 「记」类动词，主语必须不是「我」：「我记住了你说的」是陈述不是命令
 * （真要记的话它自己会命中上面的词表），「这件事你要记住」这种倒装不抓——宁少不漏报。
 * 动词表里刻意不收「别忘了」：那多半是叮嘱别人别忘带伞、别忘关门的临时提醒，
 * 不是让系统长期记一件事；收了它反而给闸门开了个漏记的后门。
 * 也不要求句子里有「我」：「记住：黑咖啡不加糖」没有第一人称，同样是命令。
 */
const MEMORY_DIRECTIVE_RE =
  /^(?:请|麻烦|帮我|你|一定要?|务必|牢牢|千万|要)*(记住|记下|记一下|记下来)/;

export function extractMemoryDirectives(content: string, options: ExtractOptions = {}): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(SENTENCE_SPLIT)) {
    if (candidates.length >= MEMORY_CANDIDATES_PER_TURN) break;
    const text = raw.trim();
    if (text.length < MEMORY_CANDIDATE_MIN_CHARS || text.length > MEMORY_CANDIDATE_MAX_CHARS) continue;
    if (!MEMORY_DIRECTIVE_RE.test(text)) continue;
    const key = text.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // 类型沿用词表判断（「记住我喜欢黑咖啡」算偏好）；判不出来才落到事实。
    candidates.push({ text, type: classifySentence(text, options.emotionEnabled === true) ?? 'fact' });
  }
  return candidates;
}
