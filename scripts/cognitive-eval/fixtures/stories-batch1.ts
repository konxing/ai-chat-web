import type { EvalStory } from '../fixture-types';
import { memory } from './memory-factory';

/**
 * 3c 第一批：s9–s19，11 个虚构故事。
 *
 * 主题面对着任务书 7.1 补齐：工作（s9 值班、s16 通勤）、学习（s10 日语、s17 Go）、
 * 兴趣（s11 摄影、s18 烘焙）、目标（s12 存钱）、项目（s13 网关、s19 日志）、
 * 决策（s14 转组）、情绪（s15 家里人住院）。
 *
 * 这一批相对第一批多出来的覆盖面，都是刻意加的，不是顺手写的：
 * 一、origin 首次用到 hypothesis（s14-m4）和 retracted（s12-m3），personalReflection 情境第一次进池子（s15）；
 * 二、跨故事的共享词（网关在 s13 和 s14 都出现、面包在 s11/s18 都出现）——线上一个用户的池子从来不按主题切开，
 *     上一批只有 8 个故事，这种串味根本测不出来；
 * 三、每个故事都留了至少一条「按常识该答、但词法上没有共同词」的 gold（s10-p3、s13-p3、s19-p3），
 *     那几条捞不捞得回来，就是下一次要不要上向量的第一手依据。
 *
 * 规矩与第一批完全一致（见 fixture-types 文件头）：正文逐字出自声明会话的原话、日期用相对天数、
 * gold 是封闭集合。所有故事全部虚构，未使用任何真实家庭成员的聊天记录。
 */

export const BATCH1_STORIES: EvalStory[] = [
  {
    id: 's9',
    title: '值班表与告警升级',
    themes: ['工作'],
    sessions: [
      {
        id: 's9-1',
        day: -80,
        lines: ['我现在值周中的夜班', '告警群叫「生产哨兵」', '白班是小郑负责']
      },
      { id: 's9-2', day: -55, lines: ['我现在值周中的夜班', '告警群里的机器人是我搭的'] },
      { id: 's9-3', day: -30, lines: ['值班表从这周起改成两天一轮', '我不再值夜班了'] },
      { id: 's9-4', day: -15, lines: ['告警超过三分钟没确认就得打电话给我', '电话那条链路还没打通'] },
      { id: 's9-5', day: -6, lines: ['值班表从这周起改成两天一轮'] },
      { id: 's9-6', day: -1, lines: ['我现在值什么班', '告警没人确认会怎么样'] }
    ],
    memories: [
      memory('s9-m1', '我现在值周中的夜班', 's9-1', -80, {
        context: 'technicalProject',
        supports: 2,
        supersededDay: -30,
        note: 's9-3 用户自己说不值夜班了，这行被取代'
      }),
      memory('s9-m2', '白班是小郑负责', 's9-1', -80, { context: 'technicalProject' }),
      memory('s9-m3', '告警群叫「生产哨兵」', 's9-1', -80, { context: 'technicalProject' }),
      memory('s9-m4', '告警群里的机器人是我搭的', 's9-2', -55, { context: 'technicalProject', origin: 'observed' }),
      memory('s9-m5', '值班表从这周起改成两天一轮', 's9-3', -30, {
        context: 'technicalProject',
        supports: 2,
        note: 's9-3 与 s9-5 两次原话'
      }),
      memory('s9-m6', '我不再值夜班了', 's9-3', -30, { context: 'technicalProject', version: 2 }),
      memory('s9-m7', '告警超过三分钟没确认就得打电话给我', 's9-4', -15, {
        context: 'technicalProject',
        type: 'decision',
        contradicts: 1,
        note: '同一会话里用户自己补了「电话那条链路还没打通」，规则写了但做不到，是一条反对证据'
      }),
      memory('s9-m8', '电话那条链路还没打通', 's9-4', -15, { context: 'technicalProject' })
    ],
    probes: [
      {
        id: 's9-p1',
        query: '我现在值什么班',
        session: 's9-6',
        gold: ['s9-m5', 's9-m6'],
        forbidden: ['s9-m1'],
        category: 'update',
        why: '当前说法是两天一轮且不值夜班；夜班那行盖了 supersededAt，出现就是旧版本泄漏'
      },
      {
        id: 's9-p2',
        query: '告警超过三分钟没人确认会怎么样',
        session: 's9-6',
        gold: ['s9-m7'],
        expectLowMarked: ['s9-m7'],
        category: 'conflict',
        why: '有反对证据（链路没打通），必须封在低档并带标注，不能当成一件已经生效的机制陈述'
      },
      {
        id: 's9-p3',
        query: '告警群叫什么名字',
        session: 's9-6',
        gold: ['s9-m3'],
        category: 'recall',
        why: 's9-1 原话，池子里唯一讲群名的一条'
      },
      {
        id: 's9-p4',
        query: '白班是谁在值',
        session: 's9-6',
        gold: ['s9-m2'],
        category: 'recall',
        why: 's9-1 原话；s1-m5「组里新来的同事负责搜索服务」同样是「某人负责某块」，但不该被当成答案'
      }
    ]
  },

  {
    id: 's10',
    title: '学日语与那本教材',
    themes: ['学习'],
    sessions: [
      { id: 's10-1', day: -110, lines: ['我在学日语', '我用的是《标准日本语》初级上'] },
      { id: 's10-2', day: -70, lines: ['我在学日语', '我每周日是日语角'] },
      { id: 's10-3', day: -40, lines: ['五十音早过了，现在在啃动词变形', '我打算明年三月考 N3'] },
      { id: 's10-4', day: -20, lines: ['日语角我改成周三晚上了'] },
      { id: 's10-5', day: -9, lines: ['《标准日本语》初级上我还没学完', '我最近改成看日剧背单词'] },
      { id: 's10-6', day: -1, lines: ['我的日语学到哪了', '日语角是什么时候'] }
    ],
    memories: [
      memory('s10-m1', '我在学日语', 's10-1', -110, {
        context: 'learning',
        type: 'goal',
        supports: 2,
        note: 's10-1 与 s10-2 两次原话'
      }),
      memory('s10-m2', '我用的是《标准日本语》初级上', 's10-1', -110, { context: 'learning' }),
      memory('s10-m3', '我每周日是日语角', 's10-2', -70, {
        context: 'learning',
        version: 1,
        supersededDay: -20,
        note: 's10-4 用户自己改到周三'
      }),
      memory('s10-m4', '五十音早过了，现在在啃动词变形', 's10-3', -40, { context: 'learning' }),
      memory('s10-m5', '我打算明年三月考 N3', 's10-3', -40, {
        context: 'personalGoal',
        type: 'goal',
        note: '目标与考试绑定在这一句里'
      }),
      memory('s10-m6', '日语角我改成周三晚上了', 's10-4', -20, { context: 'learning', version: 2 }),
      memory('s10-m7', '《标准日本语》初级上我还没学完', 's10-5', -9, { context: 'learning' }),
      memory('s10-m8', '我最近改成看日剧背单词', 's10-5', -9, { context: 'learning', type: 'preference' })
    ],
    probes: [
      {
        id: 's10-p1',
        query: '我的日语学到哪一步了',
        session: 's10-6',
        gold: ['s10-m4', 's10-m1'],
        category: 'recall',
        why: '进度问的是「在啃哪一块」加上「还在学吗」；动词变形那句是唯一答案'
      },
      {
        id: 's10-p2',
        query: '日语角是星期几',
        session: 's10-6',
        gold: ['s10-m6'],
        forbidden: ['s10-m3'],
        category: 'update',
        why: '周日那行已被取代；这一条也检验「日语」这个词在池子里被 s10 之外多少条共用'
      },
      {
        id: 's10-p3',
        query: '我要考哪个级别',
        session: 's10-6',
        gold: ['s10-m5'],
        category: 'recall',
        why: '唯一的考证记忆。问法和原话没有共同词（级别 / N3、考 / 打算考），能不能捞回来是向量要不要上的直接证据'
      },
      {
        id: 's10-p4',
        query: '教材用的是哪本',
        session: 's10-6',
        gold: ['s10-m2', 's10-m7'],
        category: 'recall',
        why: '两条都点名同一本教材，一条讲在用、一条讲没学完，都该进答案'
      }
    ]
  },

  {
    id: 's11',
    title: '摄影：建筑、菜市场与长焦',
    themes: ['兴趣'],
    sessions: [
      { id: 's11-1', day: -95, lines: ['我周末在拍城市建筑', '我的相机是富士 X-S10'] },
      { id: 's11-2', day: -60, lines: ['我加了一个长焦镜头', '我周末在拍城市建筑'] },
      { id: 's11-3', day: -35, lines: ['我不拍建筑了，最近在拍菜市场', '长焦卖掉了，换回 23mm 定焦'] },
      { id: 's11-4', day: -14, lines: ['我想把菜市场的片子做成一本手工书', '胶卷太贵，还是用数码'] },
      { id: 's11-5', day: -5, lines: ['我又开始拍建筑了', '菜市场那本手工书还在印'] },
      { id: 's11-6', day: -1, lines: ['我最近在拍什么', '我的相机是什么型号'] }
    ],
    memories: [
      memory('s11-m1', '我周末在拍城市建筑', 's11-1', -95, {
        context: 'personalGoal',
        type: 'goal',
        version: 1,
        supports: 2,
        supersededDay: -35,
        note: 's11-3 说不拍建筑了，这行被取代；s11-5 的新说法另起一行'
      }),
      memory('s11-m2', '我的相机是富士 X-S10', 's11-1', -95),
      memory('s11-m3', '我加了一个长焦镜头', 's11-2', -60, {
        version: 1,
        supersededDay: -35,
        note: 's11-3 说长焦卖掉了'
      }),
      memory('s11-m4', '我不拍建筑了，最近在拍菜市场', 's11-3', -35, {
        context: 'personalGoal',
        type: 'goal',
        version: 2,
        supersededDay: -5,
        note: 's11-5 第三次改口把它取代'
      }),
      memory('s11-m5', '长焦卖掉了，换回 23mm 定焦', 's11-3', -35, { version: 2 }),
      memory('s11-m6', '我想把菜市场的片子做成一本手工书', 's11-4', -14, {
        context: 'personalGoal',
        type: 'goal'
      }),
      memory('s11-m7', '胶卷太贵，还是用数码', 's11-4', -14, { type: 'preference' }),
      memory('s11-m8', '我又开始拍建筑了', 's11-5', -5, {
        context: 'personalGoal',
        type: 'goal',
        version: 3,
        contradicts: 1,
        note: 's11-3 明说「我不拍建筑了」，是这一行的反对证据；三次改口之后谁都不是定论，必须压在低档'
      }),
      memory('s11-m9', '菜市场那本手工书还在印', 's11-5', -5, { context: 'personalGoal' })
    ],
    probes: [
      {
        id: 's11-p1',
        query: '我最近在拍什么',
        session: 's11-6',
        gold: ['s11-m8', 's11-m9'],
        forbidden: ['s11-m1', 's11-m4'],
        expectLowMarked: ['s11-m8'],
        category: 'conflict',
        why: '当前两条是建筑（又回来了）和菜市场手工书；被取代的两行不许出现，且带反对证据的最新那条必须带低可信标注'
      },
      {
        id: 's11-p2',
        query: '我的相机是什么型号',
        session: 's11-6',
        gold: ['s11-m2'],
        category: 'recall',
        why: 's11-1 原话，唯一讲机身型号的一条'
      },
      {
        id: 's11-p3',
        query: '我现在用什么镜头',
        session: 's11-6',
        gold: ['s11-m5'],
        forbidden: ['s11-m3'],
        category: 'update',
        why: '长焦已卖、换回定焦；旧的那行盖了 supersededAt'
      },
      {
        id: 's11-p4',
        query: '我用胶卷还是数码',
        session: 's11-6',
        gold: ['s11-m7'],
        category: 'recall',
        why: 's11-4 原话，问法与原话共享「胶卷」「数码」两个词，是词法召回该赢的一类'
      }
    ]
  },

  {
    id: 's12',
    title: '存钱：六万改四万',
    themes: ['目标'],
    sessions: [
      { id: 's12-1', day: -120, lines: ['我今年要存下六万', '我给自己定的是每月存五千'] },
      { id: 's12-2', day: -80, lines: ['我今年要存下六万', '基金那边亏了，我不看账户'] },
      { id: 's12-3', day: -45, lines: ['我把目标改成四万了'] },
      { id: 's12-4', day: -20, lines: ['我不记基金那笔了，删掉吧', '我把目标改成四万了'] },
      { id: 's12-5', day: -8, lines: ['我每个月固定转五千到储蓄账户', '我周末在算这个月还剩多少能存'] },
      { id: 's12-6', day: -1, lines: ['我的存钱目标是多少', '我每个月存多少'] }
    ],
    memories: [
      memory('s12-m1', '我今年要存下六万', 's12-1', -120, {
        context: 'personalGoal',
        type: 'goal',
        version: 1,
        supports: 2,
        supersededDay: -45,
        note: 's12-3 用户把目标降下来'
      }),
      memory('s12-m2', '我给自己定的是每月存五千', 's12-1', -120, { context: 'personalGoal', type: 'goal' }),
      memory('s12-m3', '基金那边亏了，我不看账户', 's12-2', -80, {
        origin: 'retracted',
        note: 's12-4 用户要求删掉这一笔。这行留在 fixture 里只为了验候选池真的不收它——撤回的可见性由 SQL 层守，不在这里计分'
      }),
      memory('s12-m4', '我把目标改成四万了', 's12-3', -45, {
        context: 'personalGoal',
        type: 'goal',
        version: 2,
        supports: 2,
        note: 's12-3 与 s12-4 两次原话'
      }),
      memory('s12-m5', '我每个月固定转五千到储蓄账户', 's12-5', -8, { context: 'personalGoal', type: 'decision' }),
      memory('s12-m6', '我周末在算这个月还剩多少能存', 's12-5', -8, {
        origin: 'inferred',
        note: '系统从这句话归纳出「他在跟踪存款进度」；正文按原话存，但来源不是亲口确认，档位要低'
      })
    ],
    probes: [
      {
        id: 's12-p1',
        query: '我的存钱目标是多少',
        session: 's12-6',
        gold: ['s12-m4'],
        forbidden: ['s12-m1', 's12-m3'],
        category: 'update',
        why: '当前目标是四万；六万那行已被取代，基金那行是用户亲手撤回的，两个都不许出现在上下文里'
      },
      {
        id: 's12-p2',
        query: '我每个月存多少',
        session: 's12-6',
        gold: ['s12-m2', 's12-m5'],
        category: 'recall',
        why: '两句都是每月五千的说法，一旧一新、都没被取代，答案要两条一起才完整'
      },
      {
        id: 's12-p3',
        query: '这个月的存款进度我在跟吗',
        session: 's12-6',
        gold: ['s12-m6'],
        expectLowMarked: ['s12-m6'],
        category: 'recall',
        why: '来源是系统推断，注入时必须带低可信标注；标注这一栏由全局的「该标低可信却没标」统计'
      }
    ]
  },

  {
    id: 's13',
    title: '网关重构',
    themes: ['项目', '工作'],
    sessions: [
      { id: 's13-1', day: -60, lines: ['我在做网关重构', '网关的目标是把鉴权从业务代码里挪出去'] },
      { id: 's13-2', day: -40, lines: ['我负责网关重构这条路', '灰度先放百分之十的流量'] },
      { id: 's13-3', day: -25, lines: ['网关的鉴权改成了 JWT', '旧 session 那套还得留着兼容'] },
      { id: 's13-4', day: -12, lines: ['灰度放到一半了', '百分之十那个量太小，看不出问题'] },
      { id: 's13-5', day: -3, lines: ['我在做网关重构'] },
      { id: 's13-6', day: -1, lines: ['网关现在做到哪一步', '鉴权用的是什么'] }
    ],
    memories: [
      memory('s13-m1', '我在做网关重构', 's13-1', -60, {
        context: 'technicalProject',
        type: 'project',
        supports: 2,
        note: 's13-1 与 s13-5 两次原话；s13-2「我负责网关重构这条路」是另一行，不计在这条上'
      }),
      memory('s13-m2', '网关的目标是把鉴权从业务代码里挪出去', 's13-1', -60, {
        context: 'technicalProject',
        type: 'goal'
      }),
      memory('s13-m3', '我负责网关重构这条路', 's13-2', -40, {
        context: 'technicalProject',
        origin: 'observed',
        note: '这句话在对话里是以「大家都这么说」的形式出现的，来源算观察而不是亲口确认'
      }),
      memory('s13-m4', '灰度先放百分之十的流量', 's13-2', -40, {
        context: 'technicalProject',
        version: 1,
        supersededDay: -12,
        note: 's13-4 改到一半'
      }),
      memory('s13-m5', '网关的鉴权改成了 JWT', 's13-3', -25, { context: 'technicalProject', version: 2 }),
      memory('s13-m6', '旧 session 那套还得留着兼容', 's13-3', -25, { context: 'technicalProject' }),
      memory('s13-m7', '灰度放到一半了', 's13-4', -12, { context: 'technicalProject', type: 'project', version: 2 }),
      memory('s13-m8', '百分之十那个量太小，看不出问题', 's13-4', -12, {
        context: 'technicalProject',
        type: 'decision'
      })
    ],
    probes: [
      {
        id: 's13-p1',
        query: '网关现在做到哪一步了',
        session: 's13-6',
        gold: ['s13-m7'],
        forbidden: ['s13-m4'],
        category: 'update',
        why: '最新进度是灰度一半；百分之十那行已被取代'
      },
      {
        id: 's13-p2',
        query: '鉴权用的是什么方案',
        session: 's13-6',
        gold: ['s13-m5', 's13-m6'],
        category: 'recall',
        why: '改成了 JWT 但旧的 session 还留着，两条都在有效期里，只答一半就是错的'
      },
      {
        id: 's13-p3',
        query: '网关重构是谁在跟',
        session: 's13-6',
        gold: ['s13-m3'],
        forbidden: ['s1-m5'],
        expectLowMarked: ['s13-m3'],
        category: 'recall',
        why: '跨故事串味的钉子：s1-m5 也是「某人负责某块业务」的句式，但不是网关；同时这条来源是观察，要带标注'
      },
      {
        id: 's13-p4',
        query: '为什么要做网关重构',
        session: 's13-6',
        gold: ['s13-m2'],
        category: 'recall',
        why: 's13-1 原话，唯一讲动机的一条'
      }
    ]
  },

  {
    id: 's14',
    title: '要不要转去中台组',
    themes: ['决策'],
    sessions: [
      { id: 's14-1', day: -50, lines: ['我在想要不要转到中台组', '中台组那边主管跟我谈过一次'] },
      { id: 's14-2', day: -35, lines: ['我先不转，把手上的网关收尾', '中台组的岗位好像要黄'] },
      { id: 's14-3', day: -20, lines: ['网关收尾了', '我又开始考虑转中台组'] },
      { id: 's14-4', day: -7, lines: ['我决定转去中台组', '下周一我跟现主管提'] },
      { id: 's14-5', day: -2, lines: ['我决定转去中台组'] },
      { id: 's14-6', day: -1, lines: ['我转组的事定了吗', '我什么时候开始想转组的'] }
    ],
    memories: [
      memory('s14-m1', '我在想要不要转到中台组', 's14-1', -50, {
        context: 'personalGoal',
        type: 'decision',
        note: '情境用 personalGoal：decisionMaking 默认要用户确认，而确认界面还没做，真实写侧今天落不进那一类'
      }),
      memory('s14-m2', '中台组那边主管跟我谈过一次', 's14-1', -50, { context: 'personalGoal' }),
      memory('s14-m3', '我先不转，把手上的网关收尾', 's14-2', -35, {
        context: 'personalGoal',
        type: 'decision',
        version: 1,
        supersededDay: -7,
        note: 's14-4 用户定了要转，这行被取代'
      }),
      memory('s14-m4', '中台组的岗位好像要黄', 's14-2', -35, {
        origin: 'hypothesis',
        note: '「好像」是未经证实的猜测，基线只有 0.15；这一行专门用来验假设类记忆不许以事实口气进提示词'
      }),
      memory('s14-m5', '我又开始考虑转中台组', 's14-3', -20, { context: 'personalGoal', type: 'decision' }),
      memory('s14-m6', '我决定转去中台组', 's14-4', -7, {
        context: 'personalGoal',
        type: 'decision',
        version: 2,
        supports: 2,
        note: 's14-4 与 s14-5 两次原话'
      }),
      memory('s14-m7', '下周一我跟现主管提', 's14-4', -7, {
        context: 'personalGoal',
        type: 'decision',
        validFromDay: 3,
        note: '说的是下周的事，此刻还没发生'
      }),
      memory('s14-m8', '网关收尾了', 's14-3', -20, { context: 'technicalProject', type: 'project' })
    ],
    probes: [
      {
        id: 's14-p1',
        query: '我转组的事定了吗',
        session: 's14-6',
        gold: ['s14-m6'],
        forbidden: ['s14-m3', 's14-m1'],
        category: 'update',
        why: '最新说法是「决定转」；「先不转」已取代，最初的犹豫没有新说法覆盖、但也不是当前结论'
      },
      {
        id: 's14-p2',
        query: '中台组的岗位稳不稳',
        session: 's14-6',
        gold: ['s14-m4'],
        expectLowMarked: ['s14-m4'],
        category: 'conflict',
        why: '这是一条 hypothesis，来源基线最低，出现就必须带低可信标注——不能把猜测讲成岗位要黄了'
      },
      {
        id: 's14-p3',
        query: '我跟主管提转组了吗',
        session: 's14-6',
        gold: [],
        forbidden: ['s14-m7'],
        category: 'temporal',
        why: '那是下周一才做的事，validFrom 还没到；捞回来说出来就是把计划讲成已经发生'
      },
      {
        id: 's14-p4',
        query: '我什么时候开始想转组的',
        session: 's14-6',
        gold: ['s14-m1', 's14-m5'],
        category: 'recall',
        why: '这条问的是「犹豫的整个过程」，最初那句和中途反悔那句都得在场，只给最新决定就答不全'
      }
    ]
  },

  {
    id: 's15',
    title: '家里人住院与自我复盘',
    themes: ['情绪'],
    sessions: [
      { id: 's15-1', day: -40, lines: ['我爸下周要做个手术，我有点慌', '工作的事先放一放'] },
      { id: 's15-2', day: -30, lines: ['手术挺顺利的', '我不太想在别的地方提家里看病的事'] },
      { id: 's15-3', day: -18, lines: ['我在复盘这几个月对自己的要求是不是太高', '我总在把事情往最坏想'] },
      { id: 's15-4', day: -9, lines: ['我最近开始写日记，把自己理一理'] },
      { id: 's15-5', day: -4, lines: ['我爸恢复得不错，复查排在下个月'] },
      { id: 's15-6', day: -1, lines: ['我爸恢复得怎么样', '我最近在整理什么'] }
    ],
    memories: [
      memory('s15-m1', '我爸下周要做个手术，我有点慌', 's15-1', -40, {
        context: 'emotionalSupport',
        type: 'emotion'
      }),
      memory('s15-m2', '工作的事先放一放', 's15-1', -40, { context: 'emotionalSupport', type: 'decision' }),
      memory('s15-m3', '手术挺顺利的', 's15-2', -30, { context: 'emotionalSupport' }),
      memory('s15-m4', '我不太想在别的地方提家里看病的事', 's15-2', -30, {
        context: 'emotionalSupport',
        note: '这一句本身就是用户对边界的说法，是这一组 forgetting 提问的标注依据'
      }),
      memory('s15-m5', '我在复盘这几个月对自己的要求是不是太高', 's15-3', -18, { context: 'personalReflection' }),
      memory('s15-m6', '我总在把事情往最坏想', 's15-3', -18, {
        context: 'personalReflection',
        origin: 'inferred',
        note: '从两句复盘里归纳出来的性格说法。敏感情境 + 推断来源，双重压低——绝不能跨会话被端出去'
      }),
      memory('s15-m7', '我最近开始写日记，把自己理一理', 's15-4', -9, {
        type: 'preference',
        note: '刻意记在 general：写日记这件事本身不是隐私内容，必须跨会话可用，否则就是过滤过头'
      }),
      memory('s15-m8', '我爸恢复得不错，复查排在下个月', 's15-5', -4, { context: 'emotionalSupport' })
    ],
    probes: [
      {
        id: 's15-p1',
        query: '我爸那个手术顺利吗',
        session: 's15-2',
        gold: ['s15-m3'],
        forbidden: ['s15-m5', 's15-m6'],
        category: 'recall',
        why: '同一次对话里问的，sessionOnly 的记忆这时候必须可见——这条是「过滤过头」的对照组'
      },
      {
        id: 's15-p2',
        query: '我爸恢复得怎么样了',
        session: 's15-6',
        gold: [],
        forbidden: ['s15-m8', 's15-m3', 's15-m1'],
        category: 'forgetting',
        why: '换了一个会话，emotionalSupport 的三条全部不可见；用户自己说过不想在别处提（s15-m4）'
      },
      {
        id: 's15-p3',
        query: '我最近在整理什么',
        session: 's15-6',
        gold: ['s15-m7'],
        forbidden: ['s15-m5', 's15-m6'],
        category: 'forgetting',
        why: '写日记是 general 习惯，跨会话照旧可用；两句自我复盘在 personalReflection，必须留在原会话里'
      }
    ]
  },

  {
    id: 's16',
    title: '搬家、通勤与远程日',
    themes: ['工作'],
    sessions: [
      { id: 's16-1', day: -85, lines: ['我每周三周五远程办公', '我家在城南'] },
      { id: 's16-2', day: -50, lines: ['远程那天我一般上午十点到下午四点在线', '通勤单程要一个半小时'] },
      { id: 's16-3', day: -30, lines: ['我搬到了城西', '通勤缩短到四十分钟'] },
      { id: 's16-4', day: -10, lines: ['周三周五远程改成了周二周四', '主管说周三要全员到岗'] },
      { id: 's16-5', day: -5, lines: ['主管说周三要全员到岗', '我搬到了城西'] },
      { id: 's16-6', day: -1, lines: ['我哪几天远程', '我住在哪个方向'] }
    ],
    memories: [
      memory('s16-m1', '我每周三周五远程办公', 's16-1', -85, {
        version: 1,
        supersededDay: -10,
        note: 's16-4 改成周二周四'
      }),
      memory('s16-m2', '我家在城南', 's16-1', -85, { version: 1, supersededDay: -30, note: 's16-3 搬到城西' }),
      memory('s16-m3', '远程那天我一般上午十点到下午四点在线', 's16-2', -50, { type: 'preference' }),
      memory('s16-m4', '通勤单程要一个半小时', 's16-2', -50, { version: 1, supersededDay: -30 }),
      memory('s16-m5', '我搬到了城西', 's16-3', -30, { supports: 2, version: 2 }),
      memory('s16-m6', '通勤缩短到四十分钟', 's16-3', -30, { version: 2 }),
      memory('s16-m7', '周三周五远程改成了周二周四', 's16-4', -10, { version: 2 }),
      memory('s16-m8', '主管说周三要全员到岗', 's16-4', -10, { supports: 2, origin: 'observed' })
    ],
    probes: [
      {
        id: 's16-p1',
        query: '我哪几天远程办公',
        session: 's16-6',
        gold: ['s16-m7'],
        forbidden: ['s16-m1'],
        category: 'update',
        why: '当前是周二周四；注意 s16-m8 也讲周三，它进名额不算错、但也不算答案，是补位噪声的样本'
      },
      {
        id: 's16-p2',
        query: '我住在哪个方向',
        session: 's16-6',
        gold: ['s16-m5'],
        forbidden: ['s16-m2'],
        category: 'update',
        why: '搬家后旧地址被取代。这一条的问法和原话没有共同词（住 / 搬到、方向 / 城西），捞不回来就是词法召回的边界'
      },
      {
        id: 's16-p3',
        query: '我通勤要多久',
        session: 's16-6',
        gold: ['s16-m6'],
        forbidden: ['s16-m4'],
        category: 'update',
        why: '两条都讲通勤时长，旧的已取代；这一组是本次最典型的「同一话题新旧两行」'
      },
      {
        id: 's16-p4',
        query: '远程那天我几点在线',
        session: 's16-6',
        gold: ['s16-m3'],
        category: 'recall',
        why: 's16-2 原话，唯一讲在线时段的一条'
      }
    ]
  },

  {
    id: 's17',
    title: '学 Go，中间拐去 Zig 又拐回来',
    themes: ['学习'],
    sessions: [
      { id: 's17-1', day: -65, lines: ['我在学 Go', '我想用它重写一个 CLI 工具'] },
      { id: 's17-2', day: -45, lines: ['Go 的并发模型我还在看', '我在学 Go'] },
      { id: 's17-3', day: -22, lines: ['我不学 Go 了，改成学 Zig', 'Go 那本书我看到一半没看完'] },
      { id: 's17-4', day: -10, lines: ['我还是要学 Go', 'Zig 太底层了，不适合我现在的需求'] },
      { id: 's17-5', day: -3, lines: ['我在学 Go'] },
      { id: 's17-6', day: -1, lines: ['我现在在学哪门语言', '那个 CLI 工具打算用什么写'] }
    ],
    memories: [
      memory('s17-m1', '我在学 Go', 's17-1', -65, {
        context: 'learning',
        type: 'goal',
        supports: 3,
        contradicts: 1,
        note: 's17-1 / s17-2 / s17-5 三次原话，但 s17-3 明说过不学了——拉扯过的情形，档位不许按纯高档给'
      }),
      memory('s17-m2', '我想用它重写一个 CLI 工具', 's17-1', -65, { context: 'learning', type: 'goal' }),
      memory('s17-m3', 'Go 的并发模型我还在看', 's17-2', -45, { context: 'learning' }),
      memory('s17-m4', '我不学 Go 了，改成学 Zig', 's17-3', -22, {
        context: 'learning',
        type: 'goal',
        version: 2,
        supersededDay: -10,
        note: 's17-4 用户自己拐回来'
      }),
      memory('s17-m5', 'Go 那本书我看到一半没看完', 's17-3', -22, { context: 'learning' }),
      memory('s17-m6', '我还是要学 Go', 's17-4', -10, { context: 'learning', type: 'goal', version: 3 }),
      memory('s17-m7', 'Zig 太底层了，不适合我现在的需求', 's17-4', -10, {
        context: 'learning',
        type: 'decision',
        note: '这是用户给出的理由，不是系统推断，所以来源是亲口说'
      })
    ],
    probes: [
      {
        id: 's17-p1',
        query: '我现在在学哪门语言',
        session: 's17-6',
        gold: ['s17-m1', 's17-m6'],
        forbidden: ['s17-m4'],
        expectLowMarked: ['s17-m1'],
        category: 'conflict',
        why: '拐回来之后的两条当前说法；其中「我在学 Go」带过反对证据，必须带低可信标注，已取代的 Zig 那行不许出现'
      },
      {
        id: 's17-p2',
        query: '那个 CLI 工具打算用什么语言写',
        session: 's17-6',
        gold: ['s17-m2'],
        category: 'recall',
        why: '靠 latin 整词 CLI 命中；s2 的 Rust、s10 的日语都没有这个词，是词法召回该赢的一类'
      },
      {
        id: 's17-p3',
        query: 'Go 的哪一块我还没过',
        session: 's17-6',
        gold: ['s17-m3'],
        category: 'recall',
        why: '并发模型那一条；s17-m5 也讲「看到一半没看完」，两条共享「我」「看」，能不能排开是精确率的真实考题'
      },
      {
        id: 's17-p4',
        query: '为什么不学 Zig 了',
        session: 's17-6',
        gold: ['s17-m7'],
        category: 'recall',
        why: 's17-4 原话，唯一讲放弃 Zig 的理由'
      }
    ]
  },

  {
    id: 's18',
    title: '烘焙：面包、面点和换烤箱',
    themes: ['兴趣'],
    sessions: [
      { id: 's18-1', day: -75, lines: ['我周末在学做面包', '我买的烤箱是 32 升'] },
      { id: 's18-2', day: -50, lines: ['欧包太难，我改做吐司', '我在戒糖，黄油放得少'] },
      { id: 's18-3', day: -28, lines: ['我不做面包了，改成做面点', '面粉快用完了'] },
      { id: 's18-4', day: -12, lines: ['我周末在学做面包', '面点太费时间'] },
      { id: 's18-5', day: -4, lines: ['烤箱我换成 40 升的了', '32 升那个给了邻居'] },
      { id: 's18-6', day: -1, lines: ['我现在在做什么吃的', '烤箱多大'] }
    ],
    memories: [
      memory('s18-m1', '我周末在学做面包', 's18-1', -75, {
        context: 'personalGoal',
        type: 'goal',
        supports: 2,
        contradicts: 1,
        note: 's18-1 与 s18-4 两次原话；中间 s18-3 说过不做面包了，两次相反说法都没被盖 supersededAt'
      }),
      memory('s18-m2', '我买的烤箱是 32 升', 's18-1', -75, { version: 1, supersededDay: -4, note: 's18-5 换成 40 升' }),
      memory('s18-m3', '欧包太难，我改做吐司', 's18-2', -50, {
        context: 'personalGoal',
        version: 1,
        supersededDay: -28
      }),
      memory('s18-m4', '我在戒糖，黄油放得少', 's18-2', -50, { type: 'preference' }),
      memory('s18-m5', '我不做面包了，改成做面点', 's18-3', -28, {
        context: 'personalGoal',
        type: 'goal',
        version: 2,
        contradicts: 1,
        note: '与 s18-m1 互相反对：两条都是用户亲口说的，系统没能力判谁作准，只能一起留在池子里压到低档'
      }),
      memory('s18-m6', '面粉快用完了', 's18-3', -28, {
        validToDay: -20,
        note: '一次性的库存状态，说过就没再提，有效期按一句话的生命周期给到 -20 天'
      }),
      memory('s18-m7', '面点太费时间', 's18-4', -12, { context: 'personalGoal' }),
      memory('s18-m8', '烤箱我换成 40 升的了', 's18-5', -4, { version: 2 }),
      memory('s18-m9', '32 升那个给了邻居', 's18-5', -4)
    ],
    probes: [
      {
        id: 's18-p1',
        query: '我现在在做什么吃的',
        session: 's18-6',
        gold: ['s18-m1', 's18-m5'],
        forbidden: ['s18-m3'],
        expectLowMarked: ['s18-m1', 's18-m5'],
        category: 'conflict',
        why: '面包与面点是两次相反的说法、都没被取代，两条都带反对证据、都该标注；只有吐司那条是真的过期了'
      },
      {
        id: 's18-p2',
        query: '我家烤箱是多大的',
        session: 's18-6',
        gold: ['s18-m8'],
        forbidden: ['s18-m2'],
        category: 'update',
        why: '换成 40 升；32 升那行已取代，而且它现在还是「给了邻居」的物件，说出来就是错的'
      },
      {
        id: 's18-p3',
        query: '面粉还够不够',
        session: 's18-6',
        gold: [],
        forbidden: ['s18-m6'],
        category: 'temporal',
        why: 'validTo 早已过的一次性状态，捞回来等于把几周前的库存当成现在的事实'
      },
      {
        id: 's18-p4',
        query: '戒糖这事我还在做吗',
        session: 's18-6',
        gold: ['s18-m4'],
        category: 'recall',
        why: 's18-2 原话，唯一讲戒糖的一条'
      }
    ]
  },

  {
    id: 's19',
    title: '日志系统改造与 ELK 退场',
    themes: ['项目'],
    sessions: [
      { id: 's19-1', day: -55, lines: ['我在推日志系统改造', '日志统一走 OpenTelemetry'] },
      { id: 's19-2', day: -33, lines: ['老的那套 ELK 还要并行跑一个月', '改造的钱已经批了'] },
      { id: 's19-3', day: -16, lines: ['ELK 下掉了一半的索引', '日志采样率定在百分之二十'] },
      { id: 's19-4', day: -6, lines: ['日志改造一期结束了', 'ELK 还在跑'] },
      { id: 's19-5', day: -2, lines: ['我在推日志系统改造'] },
      { id: 's19-6', day: -1, lines: ['日志改造到哪一步了', '日志用什么协议采集'] }
    ],
    memories: [
      memory('s19-m1', '我在推日志系统改造', 's19-1', -55, {
        context: 'technicalProject',
        type: 'project',
        supports: 2
      }),
      memory('s19-m2', '日志统一走 OpenTelemetry', 's19-1', -55, { context: 'technicalProject' }),
      memory('s19-m3', '老的那套 ELK 还要并行跑一个月', 's19-2', -33, {
        context: 'technicalProject',
        validToDay: -3,
        note: '那句话自带时间边界：从记录日算一个月，此刻已经到期'
      }),
      memory('s19-m4', '改造的钱已经批了', 's19-2', -33, {
        context: 'technicalProject',
        origin: 'observed',
        note: '预算这件事的口径来自对话里转述的审批结果，不是用户直接确认的账目'
      }),
      memory('s19-m5', 'ELK 下掉了一半的索引', 's19-3', -16, { context: 'technicalProject' }),
      memory('s19-m6', '日志采样率定在百分之二十', 's19-3', -16, {
        context: 'technicalProject',
        type: 'decision'
      }),
      memory('s19-m7', '日志改造一期结束了', 's19-4', -6, { context: 'technicalProject', type: 'project', version: 2 }),
      memory('s19-m8', 'ELK 还在跑', 's19-4', -6, { context: 'technicalProject' })
    ],
    probes: [
      {
        id: 's19-p1',
        query: '日志改造到哪一步了',
        session: 's19-6',
        gold: ['s19-m7', 's19-m5'],
        category: 'recall',
        why: '一期结束和下掉一半索引，是当前进度的两半；池子里没有第三句讲进度'
      },
      {
        id: 's19-p2',
        query: 'ELK 那边现在什么情况',
        session: 's19-6',
        gold: ['s19-m8', 's19-m5'],
        forbidden: ['s19-m3'],
        category: 'temporal',
        why: '「再并行一个月」那句的 validTo 已过，此刻说出来就是把一个到期的计划讲成现状'
      },
      {
        id: 's19-p3',
        query: '日志用什么协议采集',
        session: 's19-6',
        gold: ['s19-m2'],
        category: 'recall',
        why: '唯一的采集方案。「协议」和原话里的「统一走 OpenTelemetry」没有共同词，靠 latin 整词才有机会命中'
      },
      {
        id: 's19-p4',
        query: '日志采样率是多少',
        session: 's19-6',
        gold: ['s19-m6'],
        category: 'recall',
        why: 's19-3 原话。注意它与 s9-m7 都含「百分之」类量词，看会不会互相挤'
      }
    ]
  }
];
