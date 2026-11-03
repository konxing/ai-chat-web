import type { MemoryContext, MemoryType } from '@/lib/cognitive/policy';
import type { MemoryOrigin } from '@/lib/cognitive/memories';

/**
 * 认知评测的 fixture 形状（任务书 7.1：每个故事 6~10 个会话 + 标准答案 + 来源证据）。
 *
 * 三个约定是刻意的，改动前先读这段：
 *
 * 一、**每条记忆的正文必须是它所在会话里用户原话的一句，一字不差。**
 * 抽取器在来源是「亲口说」时不落改写过的句子，所以正文=原话；
 * 这条同时也让「标准答案凭什么是对的」可以被机器检查（见 stories.ts 末尾的 selfCheck）。
 *
 * 二、日期用「相对评测时刻的天数」而不是绝对时间戳：保留期是按服务器现在算的，
 * 写成绝对日期过一个月整个池子就全过期了，评测会静默地变成另一回事。
 *
 * 三、gold 是「这一问该注入哪些条」的封闭集合，不是「相关的都行」。
 * 相近但不该答的那几条写进 forbidden，它挤进前 8 就是精确率的损失——那正是这次要量的东西。
 *
 * 所有故事全部虚构，不取自家里任何真实聊天记录（7.1 明令）。
 */

export interface EvalSession {
  id: string;
  /** 距评测时刻的天数，负数是过去。 */
  day: number;
  /** 用户在这个会话里说过的话；记忆正文只能出自这里。 */
  lines: string[];
}

export interface EvalMemory {
  id: string;
  content: string;
  /** 出处会话；同时决定 sessionOnly 保留期下的可见范围。 */
  session: string;
  day: number;
  type: MemoryType;
  context: MemoryContext;
  origin: MemoryOrigin;
  version?: number;
  /** 被取代的日子；写在这里的行不会进候选池（镜像 listMemories 的 supersededAt: null）。 */
  supersededDay?: number;
  /** 事实的生效/失效边界，正数是评测时刻之后。 */
  validFromDay?: number;
  validToDay?: number;
  /** 独立证据条数：支持含创建时那一条，反对是后来出现的反例。 */
  supports?: number;
  contradicts?: number;
  /** 为什么该记／不该记，标注复核时读这一句。 */
  note?: string;
}

export type ProbeCategory = 'recall' | 'update' | 'temporal' | 'conflict' | 'forgetting';

export interface EvalProbe {
  id: string;
  query: string;
  /** 提问发生在哪个会话——sessionOnly 的记忆只在这里可见。 */
  session: string;
  /** 该注入的记忆，按理想顺序排列。 */
  gold: string[];
  /** 明确不该出现在上下文里的记忆。 */
  forbidden?: string[];
  /** 这些条若被选中，必须带「可信度低」标注。 */
  expectLowMarked?: string[];
  category: ProbeCategory;
  /** 标准答案的依据：凭哪句话判定该注入这些、不该注入那些。 */
  why: string;
}

export interface EvalStory {
  id: string;
  title: string;
  /** 任务书点名的主题面：工作 / 学习 / 兴趣 / 目标 / 项目 / 决策 / 情绪。 */
  themes: string[];
  sessions: EvalSession[];
  memories: EvalMemory[];
  probes: EvalProbe[];
}
