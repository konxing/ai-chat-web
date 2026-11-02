import { MEMORY_CONTEXTS, type MemoryContext } from '@/lib/cognitive/policy';

/**
 * 词法情境分类（任务书 1.2 的前半段）：先知道这句话大概属于哪种情境，才谈得上套用哪种记忆策略。
 *
 * 为什么不用模型判情境：这个结果直接决定「要不要把内容写进长期库」，用模型输出就得再引入一层
 * 无法复算的置信度。词法打分表可以逐词解释、可以进评测集比对，出错时能找到是哪个词惹的。
 *
 * 输入：一段用户原文。输出：胜出情境、各情境得分、候选集合、是否歧义。
 * 测试：tests/unit/cognitive-context-classifier.test.ts
 *
 * 已知偏差：敏感情境（个人反思、情绪支持）的词表宁滥勿缺——误判成敏感情境只是少记一条，
 * 反过来把私密倾诉误判成技术项目则会真的落库。分档并列时不猜：两个都进候选，
 * 由写入决策挑其中最保守的一条策略。
 */
const STRONG_SCORE = 2;
const WEAK_SCORE = 1;

/** 至少要命中一个强信号，否则不足以认定情境。 */
const MIN_SCORE = 2;

/** 领先第二名不足两分＝没拉开差距，按歧义处理。 */
const MIN_MARGIN = 2;

interface SignalTable {
  context: Exclude<MemoryContext, 'general'>;
  strong: readonly string[];
  weak: readonly string[];
}

const SIGNAL_TABLES: readonly SignalTable[] = [
  {
    context: 'technicalProject',
    strong: [
      '报错',
      '异常',
      '崩溃',
      'bug',
      '编译',
      '部署',
      '迁移',
      '接口',
      '数据库',
      '外键',
      '日志',
      '依赖',
      '重构',
      '脚本',
      '服务器',
      '代码',
      '函数',
      '联调',
      '前端',
      '后端',
      'docker',
      'nginx',
      'prisma',
      'schema',
      'sql',
      'git'
    ],
    weak: ['项目', '测试', '配置', '环境', '性能', '版本', '优化', '复现', '分支']
  },
  {
    context: 'learning',
    strong: ['课程', '教材', '考试', '练习题', '作业', '教程', '复习', '论文', '入门', '考点', '做题'],
    weak: ['学习', '学到', '学会', '不懂', '讲解', '书里', '这门课', '单词']
  },
  {
    context: 'personalGoal',
    strong: [
      '目标',
      '计划',
      '打算',
      '减肥',
      '戒烟',
      '戒掉',
      '攒钱',
      '存钱',
      '早起',
      '打卡',
      '坚持',
      '养成',
      '习惯',
      '健身',
      '跑步'
    ],
    weak: ['规律', '改掉', '立个', '三个月内', '半年']
  },
  {
    context: 'personalReflection',
    strong: [
      '我是不是',
      '为什么我总是',
      '我到底',
      '自责',
      '想不通',
      '内耗',
      '什么意义',
      '人生方向',
      '我这个人',
      '复盘自己'
    ],
    weak: ['总觉得', '回想以前', '改变自己', '是不是我的问题', '价值和意义']
  },
  {
    context: 'emotionalSupport',
    strong: [
      '难受',
      '委屈',
      '生气',
      '吵架',
      '冷战',
      '想哭',
      '哭了',
      '害怕',
      '堵得慌',
      '压力大',
      '焦虑',
      '烦死',
      '孤独',
      '失眠',
      '心疼',
      '崩溃了',
      '分手',
      '情绪'
    ],
    weak: ['累', '烦', '难过', '不开心', '心情', '慌']
  },
  {
    context: 'decisionMaking',
    strong: [
      '要不要',
      '该不该',
      '选哪个',
      '纠结',
      '值不值',
      '划算',
      '预算',
      '报价',
      '权衡',
      '下单',
      '决策',
      '买不买',
      '换不换',
      '辞职',
      'offer'
    ],
    weak: ['对比', '选择', '价格', '降价', '优惠', '差价', '等等看']
  }
];

export interface ContextClassification {
  winner: MemoryContext;
  ambiguous: boolean;
  candidates: MemoryContext[];
  scores: Partial<Record<MemoryContext, number>>;
}

/** 一个词在同一段文本里出现多次只算一次，避免长文本靠复读堆出虚假置信。 */
function scoreTable(table: SignalTable, haystack: string): number {
  let score = 0;
  for (const term of table.strong) if (haystack.includes(term)) score += STRONG_SCORE;
  for (const term of table.weak) if (haystack.includes(term)) score += WEAK_SCORE;
  return score;
}

export function classifyContext(text: string): ContextClassification {
  const haystack = text.toLowerCase();
  const scores: Partial<Record<MemoryContext, number>> = {};
  for (const context of MEMORY_CONTEXTS) scores[context] = 0;
  for (const table of SIGNAL_TABLES) scores[table.context] = scoreTable(table, haystack);

  // 依 MEMORY_CONTEXTS 的固定顺序取第一个最大值：并列时谁胜出纯属表序决定，
  // 因此 ambiguous 为真时这个 winner 不享有决定权，候选集合才是给策略层看的。
  let winner: MemoryContext = 'general';
  for (const context of MEMORY_CONTEXTS) {
    if ((scores[context] ?? 0) > (scores[winner] ?? 0)) winner = context;
  }
  const top = scores[winner] ?? 0;
  // 够不上门槛就当没有情境信号，按普通情境处理：一个弱信号不足以给某个敏感情境「定罪」，
  // 把它当歧义反而会让系统对大量普通对话采取最保守策略，功能就没了。
  if (top < MIN_SCORE) return { winner: 'general', ambiguous: false, candidates: ['general'], scores };

  const runnerUp = Math.max(0, ...MEMORY_CONTEXTS.filter((c) => c !== winner).map((c) => scores[c] ?? 0));
  if (top - runnerUp >= MIN_MARGIN) return { winner, ambiguous: false, candidates: [winner], scores };

  const candidates = MEMORY_CONTEXTS.filter((context) => {
    const score = scores[context] ?? 0;
    return score > 0 && score >= top - MIN_MARGIN;
  });
  return { winner, ambiguous: true, candidates: candidates.length > 0 ? candidates : [winner], scores };
}
