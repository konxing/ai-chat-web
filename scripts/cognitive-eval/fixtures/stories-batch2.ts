import type { EvalStory } from '../fixture-types';
import { memory } from './memory-factory';

/**
 * 3c 第二批：s20–s30，铺满任务书 7.1 要求的 30 个故事。
 *
 * 主题面在第一批的基础上补齐：工作（s20 汇报线、s27 面试官）、学习（s21 雅思、s28 数据分析）、
 * 兴趣（s22 骑行、s29 钓鱼）、目标（s23 读书）、项目（s24 数据迁移、s30 组件库）、
 * 决策（s25 换车）、情绪与反思（s26 焦虑复盘，第一次成组用到 personalReflection）。
 *
 * 这一批相对第一批刻意补的三件事：
 * 一、validFrom 与 validTo 同时出现（s21-m3 已失效、s21-m5 还没生效），时间推理不再是单边的；
 * 二、「两条当前说法互相反对、谁也没被取代」这种线上最常见也最难办的形态（s22、s30），
 *     上一批只测过「有反例但仍是唯一说法」；
 * 三、第二个 retracted（s27-m7）与第二个 userConfirmed（s21-m7、s26-m7），把来源档位铺满。
 *
 * 规矩与前两批完全一致（见 fixture-types 文件头）：正文逐字出自声明会话的原话、日期用相对天数、
 * gold 是封闭集合。所有故事全部虚构，未使用任何真实家庭成员的聊天记录。
 */

export const BATCH2_STORIES: EvalStory[] = [
  {
    id: 's20',
    title: '双线汇报与那条 OKR',
    themes: ['工作'],
    sessions: [
      { id: 's20-1', day: -100, lines: ['我现在双线汇报', '行政上跟产品总监', '技术上跟架构组'] },
      { id: 's20-2', day: -70, lines: ['我的 OKR 里有一条是把发布周期压到两周', '架构组那边我是虚线'] },
      { id: 's20-3', day: -35, lines: ['发布周期先按三周走', 'OKR 那条我改了'] },
      { id: 's20-4', day: -20, lines: ['技术评审我不用参加了，架构组把我移出去了'] },
      { id: 's20-5', day: -6, lines: ['行政上跟产品总监'] },
      { id: 's20-6', day: -1, lines: ['我现在向谁汇报', '发布周期定的是多久'] }
    ],
    memories: [
      memory('s20-m1', '我现在双线汇报', 's20-1', -100),
      memory('s20-m2', '行政上跟产品总监', 's20-1', -100, { supports: 2 }),
      memory('s20-m3', '技术上跟架构组', 's20-1', -100, {
        version: 1,
        supersededDay: -20,
        note: 's20-4 用户被架构组移出去，这条不再是当前汇报关系'
      }),
      memory('s20-m4', '我的 OKR 里有一条是把发布周期压到两周', 's20-2', -70, {
        context: 'personalGoal',
        type: 'goal',
        version: 1,
        supersededDay: -35,
        note: 's20-3 把周期改成三周'
      }),
      memory('s20-m5', '发布周期先按三周走', 's20-3', -35, { context: 'technicalProject', version: 2 }),
      memory('s20-m6', 'OKR 那条我改了', 's20-3', -35, { context: 'personalGoal', type: 'decision' }),
      memory('s20-m7', '技术评审我不用参加了，架构组把我移出去了', 's20-4', -20),
      memory('s20-m8', '架构组那边我是虚线', 's20-2', -70, {
        origin: 'inferred',
        note: '从「双线汇报」和「技术上跟架构组」两句里归纳出来的说法，不是用户给的定性'
      })
    ],
    probes: [
      {
        id: 's20-p1',
        query: '我现在向谁汇报',
        session: 's20-6',
        gold: ['s20-m1', 's20-m2', 's20-m7'],
        forbidden: ['s20-m3'],
        category: 'update',
        why: '双线里行政那条仍然成立，技术那条已被「移出架构组」取代；三条合起来才是当前汇报关系'
      },
      {
        id: 's20-p2',
        query: '发布周期定的是多久',
        session: 's20-6',
        gold: ['s20-m5'],
        forbidden: ['s20-m4'],
        category: 'update',
        why: '两周那个版本已被用户自己改口，盖了 supersededAt'
      },
      {
        id: 's20-p3',
        query: '我的 OKR 改过吗',
        session: 's20-6',
        gold: ['s20-m6'],
        forbidden: ['s20-m4'],
        category: 'update',
        why: '问的是「改过」这件事，答案就是那条改口记录；被取代的旧目标不该再出现'
      },
      {
        id: 's20-p4',
        query: '我在架构组是什么角色',
        session: 's20-6',
        gold: ['s20-m8'],
        expectLowMarked: ['s20-m8'],
        category: 'recall',
        why: '这条是系统归纳的角色定性，来源是推断，注入必须带低可信标注'
      }
    ]
  },

  {
    id: 's21',
    title: '备考雅思：报了又取消',
    themes: ['学习'],
    sessions: [
      { id: 's21-1', day: -100, lines: ['我在准备雅思', '我打算考完再去考 N3'] },
      { id: 's21-2', day: -60, lines: ['我在准备雅思', '口语课每周二晚上'] },
      { id: 's21-3', day: -25, lines: ['我报名了 12 月 15 日那场', '考前一个月我要停止写周报'] },
      { id: 's21-4', day: -12, lines: ['写作一直是我的短板', '我找了个老师改作文，每周一篇'] },
      { id: 's21-5', day: -3, lines: ['我的雅思报名取消了', '改到明年三月'] },
      { id: 's21-6', day: -1, lines: ['我什么时候考雅思', '我雅思哪一项最弱'] }
    ],
    memories: [
      memory('s21-m1', '我在准备雅思', 's21-1', -100, {
        context: 'learning',
        type: 'goal',
        supports: 2,
        note: 's21-1 与 s21-2 两次原话；报名取消不等于不准备了，所以这行没有被取代'
      }),
      memory('s21-m2', '口语课每周二晚上', 's21-2', -60, { context: 'learning', type: 'preference' }),
      memory('s21-m3', '我报名了 12 月 15 日那场', 's21-3', -25, {
        context: 'learning',
        validToDay: -3,
        note: '「报了 12 月那场」这件事在 s21-5 取消报名那天就失效了'
      }),
      memory('s21-m4', '改到明年三月', 's21-5', -3, { context: 'learning', version: 2 }),
      memory('s21-m5', '考前一个月我要停止写周报', 's21-3', -25, {
        context: 'personalGoal',
        type: 'decision',
        validFromDay: 40,
        note: '那是考前一个月才生效的自我限制，此刻还没有开始'
      }),
      memory('s21-m6', '写作一直是我的短板', 's21-4', -12, { context: 'learning' }),
      memory('s21-m7', '我找了个老师改作文，每周一篇', 's21-4', -12, {
        context: 'learning',
        origin: 'userConfirmed',
        note: '用户在记忆面板里确认过这条；只有 userConfirmed 才有确认加成（任务书 3.2）'
      }),
      memory('s21-m8', '我的雅思报名取消了', 's21-5', -3, { context: 'learning', version: 2 })
    ],
    probes: [
      {
        id: 's21-p1',
        query: '我什么时候考雅思',
        session: 's21-6',
        gold: ['s21-m4'],
        forbidden: ['s21-m3'],
        category: 'temporal',
        why: '12 月那场已取消、validTo 已过；当前说法只有明年三月。捞回旧日期就是把取消掉的事说成还在'
      },
      {
        id: 's21-p2',
        query: '我雅思哪一项最弱',
        session: 's21-6',
        gold: ['s21-m6'],
        forbidden: ['s21-m2'],
        category: 'recall',
        why: '「短板」对「最弱」，词面上没有共同词；口语课那条问的是时间不是强弱，属于相近但不该答'
      },
      {
        id: 's21-p3',
        query: '谁在帮我改作文',
        session: 's21-6',
        gold: ['s21-m7'],
        category: 'recall',
        why: 's21-4 原话且用户确认过，是这一批里少数应该以确定性口气进提示词的一条'
      },
      {
        id: 's21-p4',
        query: '考前一个月我的安排是什么',
        session: 's21-6',
        gold: [],
        forbidden: ['s21-m5'],
        category: 'temporal',
        why: 'validFrom 还在四十天之后，此刻说出来就是把一个未来的自我限制讲成现在生效的规则'
      }
    ]
  },

  {
    id: 's22',
    title: '骑行：换车、六十公里与膝盖',
    themes: ['兴趣'],
    sessions: [
      { id: 's22-1', day: -90, lines: ['我周末去骑车', '我的车是捷安特的公路车'] },
      { id: 's22-2', day: -55, lines: ['我一次能骑六十公里', '我周末去骑车'] },
      { id: 's22-3', day: -30, lines: ['我换了辆旅行车', '公路车挂闲鱼卖掉了'] },
      { id: 's22-4', day: -15, lines: ['膝盖有点疼，医生让我少爬坡', '我一次能骑六十公里'] },
      { id: 's22-5', day: -5, lines: ['我改成一趟三十公里了', '骑行服我再也不买白色的'] },
      { id: 's22-6', day: -1, lines: ['我现在骑什么车', '我一次能骑多远'] }
    ],
    memories: [
      memory('s22-m1', '我周末去骑车', 's22-1', -90, {
        context: 'personalGoal',
        type: 'goal',
        supports: 2
      }),
      memory('s22-m2', '我的车是捷安特的公路车', 's22-1', -90, {
        version: 1,
        supersededDay: -30,
        note: 's22-3 换了旅行车'
      }),
      memory('s22-m3', '我一次能骑六十公里', 's22-2', -55, {
        context: 'personalGoal',
        supports: 2,
        contradicts: 1,
        note: 's22-5 改口成一趟三十公里，两次说法互相反对，但没有一条正式覆盖另一条——只能一起留着压到低档'
      }),
      memory('s22-m4', '我换了辆旅行车', 's22-3', -30, { version: 2 }),
      memory('s22-m5', '公路车挂闲鱼卖掉了', 's22-3', -30),
      memory('s22-m6', '膝盖有点疼，医生让我少爬坡', 's22-4', -15, { origin: 'observed' }),
      memory('s22-m7', '我改成一趟三十公里了', 's22-5', -5, { context: 'personalGoal', version: 2 }),
      memory('s22-m8', '骑行服我再也不买白色的', 's22-5', -5, { type: 'preference' })
    ],
    probes: [
      {
        id: 's22-p1',
        query: '我现在骑什么车',
        session: 's22-6',
        gold: ['s22-m4'],
        forbidden: ['s22-m2'],
        category: 'update',
        why: '旅行车是当前说法；公路车那行既被取代、车也已经卖了'
      },
      {
        id: 's22-p2',
        query: '我一次能骑多远',
        session: 's22-6',
        gold: ['s22-m3', 's22-m7'],
        expectLowMarked: ['s22-m3'],
        category: 'conflict',
        why: '六十与三十是两次互相反对、都没被正式取代的说法：两条都该在场，但带反对证据的那条不许以确定口气'
      },
      {
        id: 's22-p3',
        query: '骑行有什么要注意的',
        session: 's22-6',
        gold: ['s22-m6'],
        expectLowMarked: ['s22-m6'],
        category: 'recall',
        why: '医生医嘱是转述来的，来源算观察；问法与原话没有共同词，能不能捞回也是词法召回的边界'
      },
      {
        id: 's22-p4',
        query: '我周末一般干嘛',
        session: 's22-6',
        gold: ['s22-m1'],
        category: 'recall',
        why: '池子里含「周末」的行不止一条（s2 的学习时间、s11 的拍建筑、s18 的面包），这一问是共享词权重的直接考题'
      }
    ]
  },

  {
    id: 's23',
    title: '年度读书目标，一路降到取消',
    themes: ['目标'],
    sessions: [
      { id: 's23-1', day: -110, lines: ['我今年要读完二十本书', '书单我列在备忘录里'] },
      { id: 's23-2', day: -80, lines: ['我已经读完七本', '我今年要读完二十本书'] },
      { id: 's23-3', day: -45, lines: ['我把目标降到十二本', '小说类的我读不动，换成讲商业史的'] },
      { id: 's23-4', day: -20, lines: ['我读完第九本了', '《万历十五年》我读了两遍'] },
      { id: 's23-5', day: -7, lines: ['读书这件事我不再做年度目标了', '想读什么就读什么'] },
      { id: 's23-6', day: -1, lines: ['我的读书目标是多少本', '我读到第几本了'] }
    ],
    memories: [
      memory('s23-m1', '我今年要读完二十本书', 's23-1', -110, {
        context: 'personalGoal',
        type: 'goal',
        version: 1,
        supports: 2,
        supersededDay: -45
      }),
      memory('s23-m2', '书单我列在备忘录里', 's23-1', -110, { origin: 'observed' }),
      memory('s23-m3', '我已经读完七本', 's23-2', -80, {
        context: 'personalGoal',
        version: 1,
        supersededDay: -20,
        note: 's23-4 说读到第九本'
      }),
      memory('s23-m4', '我把目标降到十二本', 's23-3', -45, {
        context: 'personalGoal',
        type: 'goal',
        version: 2,
        supersededDay: -7,
        note: 's23-5 用户把这个年度目标整个取消'
      }),
      memory('s23-m5', '小说类的我读不动，换成讲商业史的', 's23-3', -45, {
        context: 'learning',
        type: 'preference'
      }),
      memory('s23-m6', '我读完第九本了', 's23-4', -20, { context: 'personalGoal', version: 2 }),
      memory('s23-m7', '《万历十五年》我读了两遍', 's23-4', -20),
      memory('s23-m8', '读书这件事我不再做年度目标了', 's23-5', -7, {
        context: 'personalGoal',
        type: 'decision',
        version: 3
      }),
      memory('s23-m9', '想读什么就读什么', 's23-5', -7, { context: 'personalGoal', type: 'preference' })
    ],
    probes: [
      {
        id: 's23-p1',
        query: '我的读书目标是多少本',
        session: 's23-6',
        gold: ['s23-m8'],
        forbidden: ['s23-m1', 's23-m4'],
        category: 'update',
        why: '三个版本连着走过 20→12→取消，只有最新那条是当前状态；旧的两条都在版本链上，出现就是泄漏'
      },
      {
        id: 's23-p2',
        query: '我读到第几本了',
        session: 's23-6',
        gold: ['s23-m6'],
        forbidden: ['s23-m3'],
        category: 'update',
        why: '进度是同一件事的新旧两版；七本那行已盖 supersededAt'
      },
      {
        id: 's23-p3',
        query: '我读的是什么类型的书',
        session: 's23-6',
        gold: ['s23-m5'],
        category: 'recall',
        why: 's23-3 原话，唯一讲阅读取向的一条'
      },
      {
        id: 's23-p4',
        query: '《万历十五年》我读了几遍',
        session: 's23-6',
        gold: ['s23-m7'],
        category: 'recall',
        why: '书名是唯一强特征，检验整句里的专名有没有被 IDF 加权顶住'
      }
    ]
  },

  {
    id: 's24',
    title: '历史数据迁移与那个没做的回滚方案',
    themes: ['项目', '工作'],
    sessions: [
      { id: 's24-1', day: -60, lines: ['我在做订单数据的历史迁移', '迁移要停机，窗口定在周六凌晨'] },
      { id: 's24-2', day: -40, lines: ['回滚方案我先不做', 'DBA 说数据量太大，一次迁不完'] },
      { id: 's24-3', day: -22, lines: ['改成分批迁，按季度切', '迁移窗口改到周日下午'] },
      { id: 's24-4', day: -9, lines: ['第一批季度数据已经迁完了', '校验脚本还没写'] },
      { id: 's24-5', day: -2, lines: ['我在做订单数据的历史迁移'] },
      { id: 's24-6', day: -1, lines: ['数据迁移现在什么状况', '迁移要停机吗'] }
    ],
    memories: [
      memory('s24-m1', '我在做订单数据的历史迁移', 's24-1', -60, {
        context: 'technicalProject',
        type: 'project',
        supports: 2,
        note: '与 s1「订单服务」共享「订单」这个词，是刻意留下的串味样本'
      }),
      memory('s24-m2', '迁移要停机，窗口定在周六凌晨', 's24-1', -60, {
        context: 'technicalProject',
        version: 1,
        supersededDay: -22
      }),
      memory('s24-m3', '回滚方案我先不做', 's24-2', -40, {
        context: 'technicalProject',
        type: 'decision',
        contradicts: 1,
        note: '同一会话里 DBA 说一次迁不完，后来 s24-3 真的改成分批——一个不分批前提下「先不做回滚」的决定，和新方案对不上'
      }),
      memory('s24-m4', 'DBA 说数据量太大，一次迁不完', 's24-2', -40, {
        context: 'technicalProject',
        origin: 'observed'
      }),
      memory('s24-m5', '改成分批迁，按季度切', 's24-3', -22, { context: 'technicalProject', type: 'decision' }),
      memory('s24-m6', '迁移窗口改到周日下午', 's24-3', -22, { context: 'technicalProject', version: 2 }),
      memory('s24-m7', '第一批季度数据已经迁完了', 's24-4', -9, { context: 'technicalProject', type: 'project', version: 2 }),
      memory('s24-m8', '校验脚本还没写', 's24-4', -9, { context: 'technicalProject' })
    ],
    probes: [
      {
        id: 's24-p1',
        query: '数据迁移现在什么状况',
        session: 's24-6',
        gold: ['s24-m7', 's24-m8'],
        category: 'recall',
        why: '进度和风险是两件事，只有两条都在才算答上；池子里没有第三句讲当前状况'
      },
      {
        id: 's24-p2',
        query: '迁移需要停机吗',
        session: 's24-6',
        gold: ['s24-m6'],
        forbidden: ['s24-m2'],
        category: 'update',
        why: '窗口已从周六凌晨改到周日下午，旧行被取代'
      },
      {
        id: 's24-p3',
        query: '迁移怎么分批',
        session: 's24-6',
        gold: ['s24-m5'],
        category: 'recall',
        why: 's24-3 原话，唯一讲切法的一条'
      },
      {
        id: 's24-p4',
        query: '回滚方案做了吗',
        session: 's24-6',
        gold: ['s24-m3'],
        expectLowMarked: ['s24-m3'],
        category: 'conflict',
        why: '这条决定带着反对证据，必须以低可信标注出现——不能替用户把一个冒险说成既定方案'
      }
    ]
  },

  {
    id: 's25',
    title: '那辆老车到底换不换',
    themes: ['决策'],
    sessions: [
      { id: 's25-1', day: -55, lines: ['我在想要不要把那辆老车换了', '修一次要三千多'] },
      { id: 's25-2', day: -40, lines: ['我看了两台二手的', '新能源我不考虑'] },
      { id: 's25-3', day: -18, lines: ['我先不换了', '把车重新做了保养'] },
      { id: 's25-4', day: -6, lines: ['我还是决定换', '置换补贴下个月就停了'] },
      { id: 's25-5', day: -2, lines: ['我还是决定换'] },
      { id: 's25-6', day: -1, lines: ['车的事我定了吗', '为什么考虑换车'] }
    ],
    memories: [
      memory('s25-m1', '我在想要不要把那辆老车换了', 's25-1', -55, {
        context: 'personalGoal',
        type: 'decision',
        note: '情境用 personalGoal：decisionMaking 默认要用户确认，而确认界面还没做，真实写侧今天落不进那一类'
      }),
      memory('s25-m2', '修一次要三千多', 's25-1', -55),
      memory('s25-m3', '我看了两台二手的', 's25-2', -40, { context: 'personalGoal' }),
      memory('s25-m4', '新能源我不考虑', 's25-2', -40, {
        type: 'preference',
        contradicts: 1,
        note: 's25-4 说的是置换补贴，而那个补贴只挂在新能源车上；这条偏好和后来的动作对不上，但用户没有明说改口'
      }),
      memory('s25-m5', '我先不换了', 's25-3', -18, {
        context: 'personalGoal',
        type: 'decision',
        version: 1,
        supersededDay: -6
      }),
      memory('s25-m6', '把车重新做了保养', 's25-3', -18),
      memory('s25-m7', '我还是决定换', 's25-4', -6, {
        context: 'personalGoal',
        type: 'decision',
        version: 2,
        supports: 2
      }),
      memory('s25-m8', '置换补贴下个月就停了', 's25-4', -6, { validToDay: 25, note: '政策还有二十多天才到期，此刻仍然成立' })
    ],
    probes: [
      {
        id: 's25-p1',
        query: '车的事我定了吗',
        session: 's25-6',
        gold: ['s25-m7'],
        forbidden: ['s25-m5'],
        category: 'update',
        why: '三次改口之后当前结论是「决定换」；「先不换」已取代'
      },
      {
        id: 's25-p2',
        query: '我为什么考虑换车',
        session: 's25-6',
        gold: ['s25-m2', 's25-m1'],
        category: 'recall',
        why: '动机是修车贵，加上「在想要不要换」这件事本身；两条都在有效期里'
      },
      {
        id: 's25-p3',
        query: '补贴还来得及吗',
        session: 's25-6',
        gold: ['s25-m8'],
        category: 'recall',
        why: '唯一讲补贴截止的一条，validTo 还没到，该以确定性口气出现'
      },
      {
        id: 's25-p4',
        query: '我会买新能源车吗',
        session: 's25-6',
        gold: ['s25-m4'],
        expectLowMarked: ['s25-m4'],
        category: 'conflict',
        why: '这条偏好带着反对证据，必须标注；不能拿它替用户把新能源一票否掉'
      }
    ]
  },

  {
    id: 's26',
    title: '焦虑复盘，全部留在原会话',
    themes: ['情绪'],
    sessions: [
      { id: 's26-1', day: -25, lines: ['我最近总怕自己把事搞砸', '这种念头一出现我就去列清单'] },
      { id: 's26-2', day: -16, lines: ['我在记录自己的情绪触发点', '触发点是deadline前一天'] },
      { id: 's26-3', day: -10, lines: ['我发现一熬夜第二天就更糟', '我不再把工作带到床上'] },
      { id: 's26-4', day: -5, lines: ['我把咨询固定在每两周一次', '这部分我不想在别的地方说'] },
      { id: 's26-5', day: -2, lines: ['我在记录自己的情绪触发点'] },
      { id: 's26-6', day: -1, lines: ['我最近在做什么调整', '我的情绪触发点是什么'] }
    ],
    memories: [
      memory('s26-m1', '我最近总怕自己把事搞砸', 's26-1', -25, { context: 'personalReflection', type: 'emotion' }),
      memory('s26-m2', '这种念头一出现我就去列清单', 's26-1', -25, {
        context: 'personalReflection',
        type: 'preference'
      }),
      memory('s26-m3', '我在记录自己的情绪触发点', 's26-2', -16, { context: 'personalReflection', supports: 2 }),
      memory('s26-m4', '触发点是deadline前一天', 's26-2', -16, { context: 'personalReflection' }),
      memory('s26-m5', '我发现一熬夜第二天就更糟', 's26-3', -10, { context: 'personalReflection' }),
      memory('s26-m6', '我不再把工作带到床上', 's26-3', -10, { context: 'personalReflection', type: 'decision' }),
      memory('s26-m7', '我把咨询固定在每两周一次', 's26-4', -5, {
        context: 'personalReflection',
        origin: 'userConfirmed',
        note: '即使用户确认过、置信度到了高档，敏感情境的保留期照样把它留在原会话——两件事互不越权'
      }),
      memory('s26-m8', '这部分我不想在别的地方说', 's26-4', -5, {
        context: 'personalReflection',
        note: '用户自己划的边界，是下面两个 forgetting 提问的标注依据'
      })
    ],
    probes: [
      {
        id: 's26-p1',
        query: '我的情绪触发点是什么',
        session: 's26-2',
        gold: ['s26-m3', 's26-m4'],
        category: 'recall',
        why: '同一次对话里问的，personalReflection 这时候必须可用——过滤过头就是把用户正在说的话忘掉'
      },
      {
        id: 's26-p2',
        query: '我最近在做什么调整',
        session: 's26-6',
        gold: [],
        forbidden: ['s26-m1', 's26-m2', 's26-m3', 's26-m4', 's26-m5', 's26-m6', 's26-m8'],
        category: 'forgetting',
        why: '换会话以后这一组一条都不许进上下文，包括已经算到高可信的那条'
      },
      {
        id: 's26-p3',
        query: '熬夜对我有什么影响',
        session: 's26-3',
        gold: ['s26-m5', 's26-m6'],
        forbidden: ['s26-m3'],
        category: 'recall',
        why: 's26-3 那次对话里的两条都在；s26-m3 来自另一次会话，这时候就该被挡住'
      },
      {
        id: 's26-p4',
        query: '我的咨询定了多久一次',
        session: 's26-6',
        gold: [],
        forbidden: ['s26-m7'],
        category: 'forgetting',
        why: '频率这件事对用户再有用，也属于他自己划了边界的反思内容；高可信不是跨会话的理由'
      }
    ]
  },

  {
    id: 's27',
    title: '这个季度的面试官',
    themes: ['工作'],
    sessions: [
      { id: 's27-1', day: -65, lines: ['我这季度在当后端面试官', '面试题我用的是那套手写题'] },
      { id: 's27-2', day: -45, lines: ['我一面一般问四十分钟', '简历筛选不归我'] },
      { id: 's27-3', day: -28, lines: ['我把那套手写题换成系统设计了', '我这季度在当后端面试官'] },
      { id: 's27-4', day: -14, lines: ['我面完的候选人我都不想在外头说', '这季度我已经面了十一个人'] },
      { id: 's27-5', day: -4, lines: ['我不再当面试官了', 'HC 冻结了'] },
      { id: 's27-6', day: -1, lines: ['我现在还面试吗', '面试问什么'] }
    ],
    memories: [
      memory('s27-m1', '我这季度在当后端面试官', 's27-1', -65, {
        context: 'technicalProject',
        type: 'project',
        supports: 2,
        supersededDay: -4,
        note: 's27-5 用户不再当了'
      }),
      memory('s27-m2', '面试题我用的是那套手写题', 's27-1', -65, {
        context: 'technicalProject',
        version: 1,
        supersededDay: -28
      }),
      memory('s27-m3', '我一面一般问四十分钟', 's27-2', -45, { context: 'technicalProject', type: 'preference' }),
      memory('s27-m4', '简历筛选不归我', 's27-2', -45, { context: 'technicalProject', origin: 'observed' }),
      memory('s27-m5', '我把那套手写题换成系统设计了', 's27-3', -28, { context: 'technicalProject', version: 2 }),
      memory('s27-m6', '我面完的候选人我都不想在外头说', 's27-4', -14, {
        context: 'emotionalSupport',
        note: '候选人的评价属于第三方隐私，记在敏感情境、只在当次对话——这不是用户自己的情绪，是别人的信息'
      }),
      memory('s27-m7', '这季度我已经面了十一个人', 's27-4', -14, {
        origin: 'retracted',
        note: '用户后来在记忆面板里删掉了这条进度数字。留着只为验候选池真的不收它；撤回的可见性由 SQL 层守'
      }),
      memory('s27-m8', '我不再当面试官了', 's27-5', -4, { context: 'technicalProject', type: 'project', version: 2 }),
      memory('s27-m9', 'HC 冻结了', 's27-5', -4, { context: 'technicalProject' })
    ],
    probes: [
      {
        id: 's27-p1',
        query: '我现在还面试吗',
        session: 's27-6',
        gold: ['s27-m8'],
        forbidden: ['s27-m1', 's27-m7'],
        category: 'update',
        why: '当前说法是不当了；旧行被取代，被删掉的进度数字更不该出现'
      },
      {
        id: 's27-p2',
        query: '面试都问什么内容',
        session: 's27-6',
        gold: ['s27-m5'],
        forbidden: ['s27-m2'],
        category: 'update',
        why: '手写题已换成系统设计，旧版本在版本链上'
      },
      {
        id: 's27-p3',
        query: '一面大概多长时间',
        session: 's27-6',
        gold: ['s27-m3'],
        category: 'recall',
        why: 's27-2 原话；即便不当面试官了，这条习惯本身没有被撤回'
      },
      {
        id: 's27-p4',
        query: '为什么不当面试官了',
        session: 's27-6',
        gold: ['s27-m9'],
        category: 'recall',
        why: 'HC 冻结是唯一给出的理由，与 s27-m8 时间上同属一次对话'
      }
    ]
  },

  {
    id: 's28',
    title: '从学 SQL 转去做报表',
    themes: ['学习', '项目'],
    sessions: [
      { id: 's28-1', day: -70, lines: ['我在学 SQL', '我拿公司的脱敏库在练'] },
      { id: 's28-2', day: -50, lines: ['我在学 SQL', '窗口函数那块我练了三遍'] },
      { id: 's28-3', day: -30, lines: ['我改了方向，在做报表', 'SQL 够用了，先不深挖'] },
      { id: 's28-4', day: -12, lines: ['报表我要做一个自助查询的入口', '权限这块我不敢放开'] },
      { id: 's28-5', day: -3, lines: ['我把自助查询的入口上线了', '权限那块还是没放开'] },
      { id: 's28-6', day: -1, lines: ['我最近在学什么', '自助查询上线了吗'] }
    ],
    memories: [
      memory('s28-m1', '我在学 SQL', 's28-1', -70, {
        context: 'learning',
        type: 'goal',
        supports: 2,
        supersededDay: -30,
        note: 's28-3 用户自己说 SQL 够用了、改做报表'
      }),
      memory('s28-m2', '我拿公司的脱敏库在练', 's28-1', -70, { context: 'learning' }),
      memory('s28-m3', '窗口函数那块我练了三遍', 's28-2', -50, { context: 'learning' }),
      memory('s28-m4', '我改了方向，在做报表', 's28-3', -30, { context: 'learning', type: 'project', version: 2 }),
      memory('s28-m5', 'SQL 够用了，先不深挖', 's28-3', -30, { context: 'learning', type: 'decision' }),
      memory('s28-m6', '报表我要做一个自助查询的入口', 's28-4', -12, {
        context: 'technicalProject',
        type: 'goal',
        version: 1,
        supersededDay: -3,
        note: 's28-5「上线了」是同一件事的新说法，旧行盖上 supersededAt——和 s28-m7/m9 那一对同一个处理'
      }),
      memory('s28-m7', '权限这块我不敢放开', 's28-4', -12, {
        context: 'technicalProject',
        type: 'decision',
        version: 1,
        supersededDay: -3
      }),
      memory('s28-m8', '我把自助查询的入口上线了', 's28-5', -3, { context: 'technicalProject', version: 2 }),
      memory('s28-m9', '权限那块还是没放开', 's28-5', -3, { context: 'technicalProject', type: 'decision', version: 2 })
    ],
    probes: [
      {
        id: 's28-p1',
        query: '我最近在学什么',
        session: 's28-6',
        gold: ['s28-m4', 's28-m5'],
        forbidden: ['s28-m1'],
        category: 'update',
        why: '同一个问法在 s2（Rust）和 s10（日语）里 gold 完全不同：这一问验的是召回能不能把已取代的「在学 SQL」挡掉，' +
          '而不是把三个语言/工具的学习行一起端上来'
      },
      {
        id: 's28-p2',
        query: '自助查询上线了吗',
        session: 's28-6',
        gold: ['s28-m8'],
        forbidden: ['s28-m6'],
        category: 'update',
        why: '计划那句已经被「上线了」覆盖；旧行仍在版本链上但不再当前'
      },
      {
        id: 's28-p3',
        query: '报表的权限是怎么处理的',
        session: 's28-6',
        gold: ['s28-m9'],
        forbidden: ['s28-m7'],
        category: 'update',
        why: '两句话面几乎一样（「不敢放开」/「还是没放开」），只有版本链能把它们分开——这是词法召回最容易出错的一类'
      },
      {
        id: 's28-p4',
        query: 'SQL 我学到什么程度了',
        session: 's28-6',
        gold: ['s28-m3', 's28-m5'],
        category: 'recall',
        why: '进度与「够用就停」这个结论合起来才回答问题；窗口函数那条是唯一讲深度的'
      }
    ]
  },

  {
    id: 's29',
    title: '钓鱼：从台钓到收竿',
    themes: ['兴趣'],
    sessions: [
      { id: 's29-1', day: -130, lines: ['我最近迷上钓鱼', '我玩的是台钓'] },
      { id: 's29-2', day: -100, lines: ['我一般周六去水库', '钓具花了不少钱'] },
      { id: 's29-3', day: -60, lines: ['我改成夜钓了', '水库不让过夜，我换到河边'] },
      { id: 's29-4', day: -18, lines: ['我把竿子换成四米五的', '长竿挥不动，胳膊吃不消'] },
      { id: 's29-5', day: -5, lines: ['我不钓了，装备挂在闲鱼了'] },
      { id: 's29-6', day: -1, lines: ['我还钓鱼吗', '我用什么竿'] }
    ],
    memories: [
      memory('s29-m1', '我最近迷上钓鱼', 's29-1', -130, { context: 'personalGoal', type: 'goal', supersededDay: -5 }),
      memory('s29-m2', '我玩的是台钓', 's29-1', -130, { context: 'personalGoal' }),
      memory('s29-m3', '我一般周六去水库', 's29-2', -100, {
        version: 1,
        supersededDay: -60,
        note: 's29-3 换到河边'
      }),
      memory('s29-m4', '钓具花了不少钱', 's29-2', -100, { origin: 'observed' }),
      memory('s29-m5', '我改成夜钓了', 's29-3', -60, { context: 'personalGoal', version: 2, supersededDay: -5 }),
      memory('s29-m6', '水库不让过夜，我换到河边', 's29-3', -60, { version: 2 }),
      memory('s29-m7', '我把竿子换成四米五的', 's29-4', -18, { version: 2 }),
      memory('s29-m8', '长竿挥不动，胳膊吃不消', 's29-4', -18),
      memory('s29-m9', '我不钓了，装备挂在闲鱼了', 's29-5', -5, {
        context: 'personalGoal',
        type: 'goal',
        version: 3,
        note: '与 s22-m5「公路车挂闲鱼卖掉了」共享「挂闲鱼」这个说法，是刻意的跨故事串味样本'
      })
    ],
    probes: [
      {
        id: 's29-p1',
        query: '我还钓鱼吗',
        session: 's29-6',
        gold: ['s29-m9'],
        forbidden: ['s29-m1', 's29-m5'],
        category: 'update',
        why: '三个版本：迷上→夜钓→收竿。只有最新版本是当前状态，前两条都在版本链上'
      },
      {
        id: 's29-p2',
        query: '我用的什么鱼竿',
        session: 's29-6',
        gold: ['s29-m7'],
        category: 'recall',
        why: 's29-4 原话，唯一讲竿长的一条；「四米五」是这根竿的强特征'
      },
      {
        id: 's29-p3',
        query: '我去哪儿钓鱼',
        session: 's29-6',
        gold: ['s29-m6'],
        forbidden: ['s29-m3'],
        category: 'update',
        why: '已经从水库换到河边；这一问同时也在 s22（骑行）里共享「周末去哪儿」这类词，看会不会串'
      },
      {
        id: 's29-p4',
        query: '钓鱼这件事花了多少',
        session: 's29-6',
        gold: ['s29-m4'],
        expectLowMarked: ['s29-m4'],
        category: 'recall',
        why: '花费是观察来的、且「不少钱」没有具体数，低可信标注不能省'
      }
    ]
  },

  {
    id: 's30',
    title: '组件库到底还推不推',
    themes: ['项目'],
    sessions: [
      { id: 's30-1', day: -50, lines: ['我在推组件库改造', '设计那边定了新的 token 规范'] },
      { id: 's30-2', day: -35, lines: ['我先把按钮和表单迁过去', '老的 less 变量还留着'] },
      { id: 's30-3', day: -20, lines: ['组件库改造做完一半', '暗色模式我还没排期'] },
      { id: 's30-4', day: -8, lines: ['我不推组件库了，先做移动端适配', '暗色模式排到下个季度'] },
      { id: 's30-5', day: -2, lines: ['我在推组件库改造'] },
      { id: 's30-6', day: -1, lines: ['组件库还推不推', '移动端适配是谁的事'] }
    ],
    memories: [
      memory('s30-m1', '我在推组件库改造', 's30-1', -50, {
        context: 'technicalProject',
        type: 'project',
        supports: 2,
        contradicts: 1,
        note: 's30-4 说改做移动端适配，s30-5 又说还在推——最近两条互相反对，谁也没被正式取代，只能一起压到低档'
      }),
      memory('s30-m2', '设计那边定了新的 token 规范', 's30-1', -50, { context: 'technicalProject', origin: 'observed' }),
      memory('s30-m3', '我先把按钮和表单迁过去', 's30-2', -35, { context: 'technicalProject', type: 'decision' }),
      memory('s30-m4', '老的 less 变量还留着', 's30-2', -35, { context: 'technicalProject' }),
      memory('s30-m5', '组件库改造做完一半', 's30-3', -20, { context: 'technicalProject', type: 'project', version: 2 }),
      memory('s30-m6', '暗色模式我还没排期', 's30-3', -20, {
        context: 'technicalProject',
        version: 1,
        supersededDay: -8
      }),
      memory('s30-m7', '我不推组件库了，先做移动端适配', 's30-4', -8, {
        context: 'technicalProject',
        type: 'decision',
        contradicts: 1,
        note: '与 s30-m1 互为反对证据：同一件事在相隔四十天后有两个相反的说法，系统没有能力判谁作准'
      }),
      memory('s30-m8', '暗色模式排到下个季度', 's30-4', -8, { context: 'technicalProject', version: 2 })
    ],
    probes: [
      {
        id: 's30-p1',
        query: '组件库还推不推',
        session: 's30-6',
        gold: ['s30-m1', 's30-m7'],
        expectLowMarked: ['s30-m1', 's30-m7'],
        category: 'conflict',
        why: '线上最常见也最难办的形态：两条当前说法互相反对。任务书 3.3 要拦的就是「以确定的口气联想」，' +
          '这里两条都必须带低可信标注，一条不落'
      },
      {
        id: 's30-p2',
        query: '组件库迁移到哪一步了',
        session: 's30-6',
        gold: ['s30-m5', 's30-m3'],
        category: 'recall',
        why: '进度（做完一半）与切法（先按钮和表单）是两件事，合起来才回答「哪一步」'
      },
      {
        id: 's30-p3',
        query: '暗色模式什么时候做',
        session: 's30-6',
        gold: ['s30-m8'],
        forbidden: ['s30-m6'],
        category: 'update',
        why: '「还没排期」到「排到下个季度」是同一件事的新旧两版，旧行不该出现'
      },
      {
        id: 's30-p4',
        query: '旧的样式变量还留着吗',
        session: 's30-6',
        gold: ['s30-m4'],
        category: 'recall',
        why: '「less 变量」是唯一的强特征词；问法故意不用 less，考察同义表述能不能被词法召回覆盖'
      }
    ]
  }
];
