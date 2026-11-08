/**
 * 话语行为检测（P1，修复 F-05）。区分"话题域"与"话语行为/意图"，不拿主题词当意图。
 *
 * 同一句技术描述可能是倾诉/报告进度/请求排查/寻求共同判断；这里识别它在互动中的功能。
 * 纯规则、零额外模型调用；带低/中/高不确定性，不强制每次都"识别出情绪"。
 */

export const DIALOGUE_ACTS = [
  'ASK_FACT', 'ASK_EXPLANATION', 'ASK_ADVICE',
  'SHARE_EXPERIENCE', 'SHARE_PROGRESS', 'VENT',
  'EXPLORE_OPINION', 'CHALLENGE', 'CORRECT_ASSISTANT',
  'ACKNOWLEDGE', 'UNCLEAR'
] as const;
export type DialogueAct = (typeof DIALOGUE_ACTS)[number];

export type TopicDomain = 'technical' | 'learning' | 'work' | 'life' | 'emotion' | 'opinion' | 'general';

export interface DialogueUnderstanding {
  topicDomain: TopicDomain;
  dialogueAct: DialogueAct;
  /** 用户当轮明确的风格/格式指令（如"不要列点"），与意图分离。 */
  explicitStyleInstruction: boolean;
  /** 是否在纠正助手上一轮的理解。 */
  needsRepair: boolean;
  intentConfidence: 'low' | 'medium' | 'high';
}

const CORRECT_RE = /不是这个意思|你理解错了|我只是想聊聊|不要给方案|不是，|你误会了|我没问这个/;
const VENT_RE = /难受|心里烦|好烦|压力|失落|没劲|提不起|委屈|累死|喘不过气/;
const PROGRESS_RE = /修了|写完|做完|搞定|还没好|没解决|进展|拖了|总算/;
const EXPLAIN_RE = /为什么|原理|怎么理解|什么意思|机制|底层/;
const ADVICE_RE = /怎么办|该怎么|怎么选|建议|给我个方案|如何决策/;
const OPINION_RE = /你觉得|你怎么看|我认为|我觉得|是不是|利大于弊/;
const ACK_RE = /^(嗯+|好的?|对+|是啊?|没错|哦+)[。！!？?~\s]*$/;
const STYLE_RE = /不要列点|别列点|简单一点|深入一点|先给结论|像老师|详细一点/;

export function detectTopicDomain(text: string): TopicDomain {
  if (/内核|驱动|代码|函数|算法|数据库|架构|网络|协议|容器|Bug|日志|接口|缓存/.test(text)) return 'technical';
  if (/数学|导数|积分|方程|考试|复习|学习|递归|闭包/.test(text)) return 'learning';
  if (VENT_RE.test(text)) return 'emotion';
  if (/工作|领导|同事|项目|上班|创业/.test(text)) return 'work';
  if (OPINION_RE.test(text)) return 'opinion';
  if (/周末|搬家|睡眠|吃饭|出去/.test(text)) return 'life';
  return 'general';
}

export function understandDialogue(text: string): DialogueUnderstanding {
  const topicDomain = detectTopicDomain(text);
  const explicitStyleInstruction = STYLE_RE.test(text);
  const t = text.trim();

  if (CORRECT_RE.test(t)) {
    return { topicDomain, dialogueAct: 'CORRECT_ASSISTANT', explicitStyleInstruction, needsRepair: true, intentConfidence: 'high' };
  }
  if (ACK_RE.test(t)) {
    return { topicDomain, dialogueAct: 'ACKNOWLEDGE', explicitStyleInstruction, needsRepair: false, intentConfidence: 'high' };
  }
  // 话语行为优先于话题：技术词+倾诉 → VENT/SHARE_PROGRESS，而非直接排查。
  if (VENT_RE.test(t) && !EXPLAIN_RE.test(t) && !ADVICE_RE.test(t)) {
    return { topicDomain, dialogueAct: 'VENT', explicitStyleInstruction, needsRepair: false, intentConfidence: 'medium' };
  }
  if (PROGRESS_RE.test(t) && !/[？?]\s*$/.test(t) && !ADVICE_RE.test(t) && !EXPLAIN_RE.test(t)) {
    return { topicDomain, dialogueAct: 'SHARE_PROGRESS', explicitStyleInstruction, needsRepair: false, intentConfidence: 'medium' };
  }
  if (EXPLAIN_RE.test(t)) {
    return { topicDomain, dialogueAct: 'ASK_EXPLANATION', explicitStyleInstruction, needsRepair: false, intentConfidence: 'high' };
  }
  if (ADVICE_RE.test(t)) {
    return { topicDomain, dialogueAct: 'ASK_ADVICE', explicitStyleInstruction, needsRepair: false, intentConfidence: 'high' };
  }
  if (OPINION_RE.test(t)) {
    return { topicDomain, dialogueAct: 'EXPLORE_OPINION', explicitStyleInstruction, needsRepair: false, intentConfidence: 'medium' };
  }
  if (/[？?]\s*$/.test(t)) {
    return { topicDomain, dialogueAct: 'ASK_FACT', explicitStyleInstruction, needsRepair: false, intentConfidence: 'medium' };
  }
  if (/分享|经历|上次我|我曾经/.test(t)) {
    return { topicDomain, dialogueAct: 'SHARE_EXPERIENCE', explicitStyleInstruction, needsRepair: false, intentConfidence: 'medium' };
  }
  return { topicDomain, dialogueAct: 'UNCLEAR', explicitStyleInstruction, needsRepair: false, intentConfidence: 'low' };
}
