import type { MemoryType } from './policy';

/**
 * 规则抽取（任务书 Phase 2 的 MemoryExtractor 第一版）。
 *
 * 用途：把用户亲口陈述的话切成候选记忆，并给出记忆类型，交给写入决策去判要不要留。
 * 输入：用户这一轮消息的原文（绝不包含模型回复）。输出：`[{ text, type }]`，顺序按原文。
 * 测试：tests/unit/cognitive-memory-extractor.test.ts
 *
 * 为什么先不用模型：现在没配任何 provider，模型路径既跑不了也测不了；而「用户说了什么」
 * 这件事本来就有确定答案——只有第一人称的陈述句算数。问句、转述、长段落一律不抽，
 * 宁可少记。情绪句不在这里抽（那是情感引擎的活，且默认策略也不允许把情绪落长期库）。
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
  { type: 'goal', markers: ['我打算', '我计划', '我准备', '我想', '我要', '我的目标是', '以后要'] },
  { type: 'preference', markers: ['我喜欢', '我不喜欢', '我讨厌', '我习惯', '我不爱', '我偏好', '我爱'] },
  {
    type: 'fact',
    markers: ['我叫', '名字是', '我今年', '我住在', '我搬到', '我的生日', '我家在', '我有', '我没有']
  }
];

/** 只在句末标点处切：ASCII 句点留给「Next.js」「1.5」这类写法，不然技术句子会被剁碎。 */
const SENTENCE_SPLIT = /[。；;\n]+|[!?！？]+/;

/** 疑问句、疑问词结尾的句子一律不算陈述。问「我的项目怎么部署」不是在告诉我一个项目事实。 */
const QUESTION_MARK = /[?？]|怎么|如何|为什么|[吗呢]\s*$/;

export interface MemoryCandidate {
  text: string;
  type: MemoryType;
}

function classifySentence(sentence: string): MemoryType | null {
  for (const rule of RULES) {
    if (rule.markers.some((marker) => sentence.includes(marker))) return rule.type;
  }
  return null;
}

export function extractMemoryCandidates(content: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(SENTENCE_SPLIT)) {
    if (candidates.length >= MEMORY_CANDIDATES_PER_TURN) break;
    const text = raw.trim();
    if (text.length < MEMORY_CANDIDATE_MIN_CHARS || text.length > MEMORY_CANDIDATE_MAX_CHARS) continue;
    if (!text.includes('我') || QUESTION_MARK.test(text)) continue;
    const type = classifySentence(text);
    if (!type) continue;
    const key = text.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text, type });
  }
  return candidates;
}
