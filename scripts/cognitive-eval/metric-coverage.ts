/**
 * 任务书 7.3 的指标账本：29 项逐条登记「有没有真数、没有的话为什么、什么条件下才有」。
 *
 * 这份账本存在的理由是报告里那段散文已经过期过两次：Phase 4/5/6 都落地之后，
 * 「今天测不了的指标」还写着「Phase X 未开始」。一句没有机器检查的现状描述，
 * 隔两个片就会变成假话——而它恰好是别人判断「这个系统验收到什么程度」的依据。
 *
 * 状态只有两种，没有「部分可用」：
 * - computed：报告里有一个能指到代码位置的数；
 * - blocked：没有数，detail 写清缺什么，unblock 写清解锁条件。
 *
 * **把一项从 blocked 改成 computed，必须同时有实现和一条能复跑的用例。**
 * 只改这张表的 status 是把账本变成装饰品。
 */

export type MetricGroup = '记忆' | '图关联' | '认知时间线' | '主动反思' | '决策记忆' | '系统';

export interface MetricEntry {
  group: MetricGroup;
  name: string;
  status: 'computed' | 'blocked';
  /** computed：数字在哪；blocked：缺什么。必须能被另一个人复核。 */
  detail: string;
  /** 只有 blocked 有：什么条件下才可能算出这一项。 */
  unblock?: string;
}

export const METRIC_COVERAGE: readonly MetricEntry[] = [
  {
    group: '记忆',
    name: 'Recall@K',
    status: 'computed',
    detail: 'metrics.ts 的 recallAt8（K=8）；只对有标准答案的提问取均值，逐问明细在 report.md 的表里'
  },
  {
    group: '记忆',
    name: 'Precision@K',
    status: 'computed',
    detail: 'metrics.ts 的 precisionAt8；分母是实际注入条数，补位噪声会直接压低它'
  },
  { group: '记忆', name: 'MRR', status: 'computed', detail: 'metrics.ts 的 mrr；按第一条命中出现的位置取倒数' },
  {
    group: '记忆',
    name: '事实更新准确率',
    status: 'computed',
    detail: 'byCategory.update.accuracy：标准答案全中且旧版本一次都没被注入才算过'
  },
  {
    group: '记忆',
    name: '时间推理准确率',
    status: 'computed',
    detail: 'byCategory.temporal.accuracy：只判「已失效的那条有没有出现」，不要求命中全部标准答案'
  },
  {
    group: '记忆',
    name: '冲突识别准确率',
    status: 'computed',
    detail: 'byCategory.conflict.accuracy：该带低可信标注的条目一旦注入就必须带标注'
  },
  {
    group: '记忆',
    name: '选择性遗忘准确率',
    status: 'computed',
    detail: 'byCategory.forgetting.accuracy：跨会话不该出现的敏感记忆一次都不许进上下文'
  },

  {
    group: '图关联',
    name: '关系分类准确率',
    status: 'blocked',
    detail:
      '没有 MemoryRelation 表，也没有关系分类器：记忆网络是从已有的三种真实关系（演化边 / 同场对话 / 洞察引用）读时派生的，里面没有「关系类型」这个可判对错的对象',
    unblock: '按 2.3 建关系表并引入关系分类器，同时为至少一组故事标注关系类型'
  },
  {
    group: '图关联',
    name: '高置信度关系 Precision',
    status: 'blocked',
    detail: '同上：派生边没有置信度列，也就没有「高置信度」这个集合',
    unblock: '关系表落地并写入置信度后，再标一批高置信度边的人工判定'
  },
  {
    group: '图关联',
    name: '图扩展召回率',
    status: 'blocked',
    detail: '多跳检索（3.2）没有实现：读侧没有图扩展这一步，无法测「扩出来的节点里有多少是标准答案」',
    unblock: 'GraphRetriever 与多跳扩展落地后，在现有 30 个故事上补多跳标准答案'
  },
  {
    group: '图关联',
    name: '无关关联比例',
    status: 'blocked',
    detail: '没有关联候选集合：派生图只画不馈入上下文，不存在「注入了一批关联、其中多少无关」这个量',
    unblock: '图扩展进入上下文后按注入顺序统计'
  },

  {
    group: '认知时间线',
    name: '事件提取准确率',
    status: 'blocked',
    detail:
      '事件是 event-extractor 从记忆行派生的，但 30 个故事只标了记忆与提问，没有逐条事件的标准答案；用同一套规则生成再拿它当答案就是自证',
    unblock: '为每个故事标注应产出的事件（类别 + 来源记忆），规则再做对照'
  },
  {
    group: '认知时间线',
    name: '日期解析准确率',
    status: 'blocked',
    detail:
      'fixture 的日期是相对评测时刻的天数，不含「原话里的时间表达 → 期望解析结果」标注；片T-2 量过的「116 问里 1 条解析得出框架」是可解析率，不是准确率',
    unblock: '补一份逐句的时间表达标注（原话、期望 precision、期望偏移），再跑 resolveTemporalFrame'
  },
  {
    group: '认知时间线',
    name: '目标状态转换准确率',
    status: 'blocked',
    detail: 'fixture 没有目标状态迁移序列（创建 → 变更 → 完成）的标注，也没有模拟时间推进的用例',
    unblock: '为部分故事补目标状态序列，并按天推进重放'
  },
  {
    group: '认知时间线',
    name: '时间精度保留率',
    status: 'blocked',
    detail:
      'EvalMemory 不带 validPrecision（harness 的 toDto 里是常量 unknown），算不出「解析出的精度有多少被保留到落库」',
    unblock: '给 fixture 行补期望精度，并让 harness 走写侧同一段精度映射'
  },

  {
    group: '主动反思',
    name: '证据覆盖率',
    status: 'blocked',
    detail: 'harness 不跑反思扫描、不落库，手里没有一批「已生成的洞察 + 它们的证据引用」',
    unblock: '用真库或一个带洞察 fixtures 的离线快照跑 sweep，再统计每条洞察的证据数'
  },
  {
    group: '主动反思',
    name: '反例召回率',
    status: 'blocked',
    detail: '反证搜索依赖记忆池与决策池的真实检索；离线 harness 没有这套输入，也没有「哪些反例该被找到」的标注',
    unblock: '为带反例的故事标注期望反例 id，再接上 findCounterEvidence'
  },
  {
    group: '主动反思',
    name: '无依据洞察比例',
    status: 'blocked',
    detail: '同一原因：没有生成出来的洞察集合，比例无从算起',
    unblock: '先有洞察快照，再按「支持证据为空」计数'
  },
  {
    group: '主动反思',
    name: '重复洞察比例',
    status: 'blocked',
    detail: 'dedupKey 的唯一性由数据库约束守住；离线 harness 没有库，测不到跨次扫描的重复',
    unblock: '在真库上跑两轮 sweep，统计同一 dedupKey 的重复尝试'
  },
  {
    group: '主动反思',
    name: '用户反馈后的修正准确率',
    status: 'blocked',
    detail: '需要用户对洞察的采纳/拒绝/编辑事件与之后的修正结果，现有数据里没有这类交互样本',
    unblock: '真实使用攒出反馈行，或构造一套带反馈序列的离线剧本'
  },

  {
    group: '决策记忆',
    name: '决策提取准确率',
    status: 'blocked',
    detail: '30 个故事没有决策句标注；决策抽取器有单测，但没有「这句话该不该抽成决策」的金标准',
    unblock: '为故事补决策标注（应抽 / 不应抽 + 主题与选择），再跑 extractDecisionCandidates'
  },
  {
    group: '决策记忆',
    name: '决策结果匹配准确率',
    status: 'blocked',
    detail: '没有决策与其后续结果的配对标注',
    unblock: '补「哪个结果句属于哪条决策」的标注，再跑 matchOutcomes'
  },
  {
    group: '决策记忆',
    name: '相似决策召回率',
    status: 'blocked',
    detail: '没有已确认的决策集合，也没有「这一问该召回哪条决策」的标注',
    unblock: '构造决策 fixtures（含已确认状态），复用关键词评分并标标准答案'
  },
  {
    group: '决策记忆',
    name: '跨会话经验使用成功率',
    status: 'blocked',
    detail: '需要模型真的回答问题再由人判分；harness 离线不调模型',
    unblock: '接一个可重复的模型端点与判分脚本（与向量臂同一个前置条件）'
  },

  {
    group: '系统',
    name: '检索延迟',
    status: 'computed',
    detail:
      'measureLatency：200 行池子上跑 201 次取中位数，单位微秒；只打印到 stdout、不进 snapshot（每次跑都不同）。不含解密整池那一步'
  },
  {
    group: '系统',
    name: '后台任务延迟',
    status: 'blocked',
    detail: '离线 harness 没有进程也没有真库；任务从入队到收口的耗时目前只在 cognitive.task_done 日志里',
    unblock: '在真库上跑一批任务并从审计/日志取时间差'
  },
  {
    group: '系统',
    name: '模型 Token 消耗',
    status: 'blocked',
    detail: 'harness 不调模型；报告里的「平均注入字符数」是提示词体积的代理量，不是 token 数，不能顶替',
    unblock: '接真实模型端点后按 usage 字段统计'
  },
  {
    group: '系统',
    name: '每轮额外模型调用次数',
    status: 'blocked',
    detail:
      '读侧按构造不调模型（只读本地密文与纯函数），但没有运行时计数器；写侧 embedding 调用发生在后台，离线 harness 观察不到',
    unblock: '在请求路径上加一个只读计数器，随报告一起输出'
  },
  {
    group: '系统',
    name: '数据库存储增长',
    status: 'blocked',
    detail: '需要真实库与时间跨度，离线 fixture 是内存数组，没有字节数',
    unblock: '在真库上按周采样表大小与行数'
  }
];

export function coverageCounts(): { total: number; computed: number; blocked: number } {
  const computed = METRIC_COVERAGE.filter((entry) => entry.status === 'computed').length;
  return { total: METRIC_COVERAGE.length, computed, blocked: METRIC_COVERAGE.length - computed };
}