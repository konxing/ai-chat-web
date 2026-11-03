import type { EvalMemory, EvalProbe, EvalStory } from '../fixture-types';
import { memory } from './memory-factory';
import { BATCH1_STORIES } from './stories-batch1';

/**
 * 认知评测的语料入口。第一批 s1–s8 在本文件里，后续批次各占一个文件，在这里拼接。
 *
 * 覆盖面对照任务书点名的主题面：工作（s1 / s8 / s9 / s16）、学习（s2 / s10 / s17）、兴趣（s3 / s11 / s18）、
 * 目标（s4 / s12）、项目（s5 / s13 / s19）、决策（s6 / s14）、情绪交互（s7 / s15）；
 * 五种情形各有至少一次：事实变化 s1·s3·s5·s9·s16、时间冲突 s2·s4·s14·s18·s19、
 * 反例 s1·s4·s6·s9·s11·s12·s17·s18、遗忘 s7·s15、用户纠正 s3·s11·s13·s17。
 *
 * 每个故事的会话都是 6 个（7.1 要求 6~10 个）。day 是相对评测时刻的天数，负数是过去。
 *
 * 两条能被机器查的规矩写在 harness.ts 的 selfCheck 里：
 * 记忆正文必须逐字出自它声明的那个会话；supports 不许超过这句话出现过的会话数。
 * 剩下查不了的（contradicts 凭什么、gold 凭哪条判）一律要求写 note／why，
 * 复核的时候是逐条摊开看的，不是看一个总分。
 */

const CORE_STORIES: EvalStory[] = [
  {
    id: 's1',
    title: '订单服务与主库',
    themes: ['工作', '项目'],
    sessions: [
      {
        id: 's1-1',
        day: -90,
        lines: ['我在做订单服务', '我们订单服务的主库用 MySQL', '组里新来的同事负责搜索服务']
      },
      { id: 's1-2', day: -40, lines: ['我每周三下午要跟后端组开例会', '搜索服务那边我基本不管'] },
      {
        id: 's1-3',
        day: -20,
        lines: ['我把订单服务的主库从 MySQL 换成了 PostgreSQL', 'PostgreSQL 的备份我放在每夜的定时任务里']
      },
      { id: 's1-4', day: -10, lines: ['我在用 Prisma 连订单服务的库', '其实订单服务还没接 Prisma，只是准备接'] },
      { id: 's1-5', day: -5, lines: ['我在做订单服务', '夜备份挺稳的，我每天早上看一眼告警'] },
      { id: 's1-6', day: -1, lines: ['订单服务的主库现在用的什么来着', '搜索服务是谁在跟'] }
    ],
    memories: [
      memory('s1-m1', '我在做订单服务', 's1-1', -90, {
        type: 'project',
        context: 'technicalProject',
        supports: 2,
        note: 's1-1 与 s1-5 两次原话，算两次独立陈述'
      }),
      memory('s1-m2', '我们订单服务的主库用 MySQL', 's1-1', -90, {
        context: 'technicalProject',
        version: 1,
        supersededDay: -20,
        note: '被 s1-m3 取代；这行留在 fixture 里就是为了验证候选池真的把它挡在门外'
      }),
      memory('s1-m3', '我把订单服务的主库从 MySQL 换成了 PostgreSQL', 's1-3', -20, {
        context: 'technicalProject',
        version: 2
      }),
      memory('s1-m4', 'PostgreSQL 的备份我放在每夜的定时任务里', 's1-3', -20, { context: 'technicalProject' }),
      memory('s1-m5', '组里新来的同事负责搜索服务', 's1-1', -90, {
        origin: 'observed',
        note: '不是用户亲口陈述的事实来源，档位应落在低'
      }),
      memory('s1-m6', '我在用 Prisma 连订单服务的库', 's1-4', -10, {
        context: 'technicalProject',
        contradicts: 1,
        note: '同一会话里用户自己补了一句「其实还没接 Prisma」，那是一条反对证据'
      }),
      memory('s1-m7', '我每周三下午要跟后端组开例会', 's1-2', -40, {
        origin: 'userConfirmed',
        supports: 1,
        note: '用户明确确认过的安排'
      })
    ],
    probes: [
      {
        id: 's1-p1',
        query: '订单服务的主库现在用的什么',
        session: 's1-6',
        gold: ['s1-m3'],
        forbidden: ['s1-m2'],
        category: 'update',
        why: 's1-3 用户原话改口，MySQL 那行已经盖上 supersededAt，当前答案只有 PostgreSQL'
      },
      {
        id: 's1-p2',
        query: '搜索服务是谁在负责',
        session: 's1-6',
        gold: ['s1-m5'],
        expectLowMarked: ['s1-m5'],
        category: 'conflict',
        why: 's1-1 原话；来源是「观察到」而不是亲口确认，注入时必须带低可信标注'
      },
      {
        id: 's1-p3',
        query: 'Prisma 接到订单服务的库上了吗',
        session: 's1-6',
        gold: ['s1-m6'],
        expectLowMarked: ['s1-m6'],
        category: 'conflict',
        why: 's1-4 有反对证据，档位封在低，不许以确定口气进提示词'
      },
      {
        id: 's1-p4',
        query: '数据库备份是怎么做的',
        session: 's1-6',
        gold: ['s1-m4'],
        category: 'recall',
        why: 's1-3 原话，唯一的出处'
      }
    ]
  },

  {
    id: 's2',
    title: '学 Rust 与那门网课',
    themes: ['学习'],
    sessions: [
      { id: 's2-1', day: -70, lines: ['我在学 Rust', '我报的 Rust 网课在 10 月 20 日结课'] },
      { id: 's2-2', day: -60, lines: ['我在学 Rust', '每晚学四十分钟'] },
      { id: 's2-3', day: -30, lines: ['我周末要陪家里人，学习时间排在早上', '我在准备明年四月的考研'] },
      { id: 's2-4', day: -12, lines: ['我打算把所有权那一章啃完', '借用检查器那块我还没过'] },
      { id: 's2-5', day: -6, lines: ['我在学 Rust'] },
      { id: 's2-6', day: -2, lines: ['我最近在学什么', '那门网课结课了没'] }
    ],
    memories: [
      memory('s2-m1', '我在学 Rust', 's2-1', -70, {
        type: 'goal',
        context: 'learning',
        supports: 3,
        note: 's2-1 / s2-2 / s2-5 三次原话，够抬到高档'
      }),
      memory('s2-m2', '我报的 Rust 网课在 10 月 20 日结课', 's2-1', -70, {
        context: 'learning',
        validToDay: -14,
        note: '课程有效期已过，不该再被当成在读的事捞回来'
      }),
      memory('s2-m3', '每晚学四十分钟', 's2-2', -60, { context: 'learning', type: 'preference' }),
      memory('s2-m4', '我周末要陪家里人，学习时间排在早上', 's2-3', -30, {
        context: 'learning',
        type: 'preference'
      }),
      memory('s2-m5', '我在准备明年四月的考研', 's2-3', -30, {
        context: 'personalGoal',
        type: 'goal',
        supports: 1
      }),
      memory('s2-m6', '我打算把所有权那一章啃完', 's2-4', -12, { context: 'learning', type: 'goal' })
    ],
    probes: [
      {
        id: 's2-p1',
        query: '我最近在学什么',
        session: 's2-6',
        gold: ['s2-m1', 's2-m6'],
        category: 'recall',
        why: '当前在学的两件事：Rust 本身，以及这周新说的所有权那一章'
      },
      {
        id: 's2-p2',
        query: '那门网课结课了没',
        session: 's2-6',
        gold: [],
        forbidden: ['s2-m2'],
        category: 'temporal',
        why: 'validTo 已过，listMemories 的 asOf 就不该给这行；捞回来等于说了一件已经结束的事'
      },
      {
        id: 's2-p3',
        query: '我的学习安排在晚上还是早上',
        session: 's2-6',
        gold: ['s2-m4', 's2-m3'],
        category: 'recall',
        why: '两句都是亲口说的习惯，早上那句是后说的、优先'
      },
      {
        id: 's2-p4',
        query: '考研准备到哪一步了',
        session: 's2-6',
        gold: ['s2-m5'],
        category: 'recall',
        why: 's2-3 原话，池子里唯一讲考研的一条'
      }
    ]
  },

  {
    id: 's3',
    title: '小提琴，改了三次口',
    themes: ['兴趣'],
    sessions: [
      { id: 's3-1', day: -120, lines: ['我在学小提琴', '小提琴老师姓陆，每周六上午上课'] },
      { id: 's3-2', day: -90, lines: ['我周一到周五不去琴房'] },
      { id: 's3-3', day: -60, lines: ['我在学小提琴'] },
      { id: 's3-4', day: -8, lines: ['我不拉琴了，把琴送人了', '以后不用问我练琴的事'] },
      { id: 's3-5', day: -4, lines: ['小提琴老师姓陆，每周六上午上课'] },
      { id: 's3-6', day: -2, lines: ['我最近重新开始拉琴', '还是周六那节课'] },
      { id: 's3-7', day: -1, lines: ['我现在还拉小提琴吗'] }
    ],
    memories: [
      memory('s3-m1', '我在学小提琴', 's3-1', -120, {
        context: 'personalGoal',
        type: 'goal',
        version: 1,
        supports: 2,
        supersededDay: -8,
        note: 's3-4 用户明确改口，这行被取代'
      }),
      memory('s3-m2', '我不拉琴了，把琴送人了', 's3-4', -8, {
        context: 'personalGoal',
        version: 2,
        supersededDay: -2,
        note: '中间状态：s3-6 又一次改口把它取代了；用户纠正连着两次'
      }),
      memory('s3-m3', '我最近重新开始拉琴', 's3-6', -2, { context: 'personalGoal', type: 'goal', version: 3 }),
      memory('s3-m4', '小提琴老师姓陆，每周六上午上课', 's3-1', -120, { supports: 2 }),
      memory('s3-m5', '我周一到周五不去琴房', 's3-2', -90),
      memory('s3-m6', '以后不用问我练琴的事', 's3-4', -8, { context: 'personalGoal' })
    ],
    probes: [
      {
        id: 's3-p1',
        query: '我现在还拉小提琴吗',
        session: 's3-7',
        gold: ['s3-m3'],
        forbidden: ['s3-m1', 's3-m2'],
        category: 'update',
        why: '两次改口之后当前说法只有 s3-m3；前两行都盖了 supersededAt'
      },
      {
        id: 's3-p2',
        query: '我的小提琴老师是谁',
        session: 's3-7',
        gold: ['s3-m4'],
        category: 'recall',
        why: 's3-1 说过、s3-5 又原话说了一遍，两次独立陈述'
      },
      {
        id: 's3-p3',
        query: '琴房我一般什么时候去',
        session: 's3-7',
        gold: ['s3-m5'],
        category: 'recall',
        why: 's3-2 原话，池子里唯一讲琴房时间的'
      }
    ]
  },

  {
    id: 's4',
    title: '跑步计划与体检结果',
    themes: ['目标'],
    sessions: [
      { id: 's4-1', day: -45, lines: ['我打算今年跑完一次半马', '我体检查出轻度脂肪肝'] },
      { id: 's4-2', day: -30, lines: ['医生让我减少精制糖', '我每周三晚上游泳'] },
      { id: 's4-3', day: -14, lines: ['我打算今年跑完一次半马'] },
      { id: 's4-4', day: -10, lines: ['我把奶茶戒了', '上周还是喝了一次'] },
      { id: 's4-5', day: -5, lines: ['我下个月开始每周三次晨跑'] },
      { id: 's4-6', day: -1, lines: ['我的运动计划是什么', '体检有什么异常'] }
    ],
    memories: [
      memory('s4-m1', '我打算今年跑完一次半马', 's4-1', -45, {
        context: 'personalGoal',
        type: 'goal',
        supports: 2
      }),
      memory('s4-m2', '我体检查出轻度脂肪肝', 's4-1', -45, { origin: 'observed' }),
      memory('s4-m3', '医生让我减少精制糖', 's4-2', -30),
      memory('s4-m4', '我每周三晚上游泳', 's4-2', -30, { type: 'preference' }),
      memory('s4-m5', '我把奶茶戒了', 's4-4', -10, {
        type: 'preference',
        contradicts: 1,
        note: '同一会话里另一句「上周还是喝了一次」就是反例'
      }),
      memory('s4-m6', '我下个月开始每周三次晨跑', 's4-5', -5, {
        context: 'personalGoal',
        type: 'goal',
        validFromDay: 20,
        note: '计划要下个月才生效，此刻还不是一件正在做的事'
      })
    ],
    probes: [
      {
        id: 's4-p1',
        query: '我现在的运动计划是什么',
        session: 's4-6',
        gold: ['s4-m1', 's4-m4'],
        forbidden: ['s4-m6'],
        category: 'temporal',
        why: '正在做的是半马和三头的游泳；晨跑 validFrom 还没到，说出来就是把计划讲成事实'
      },
      {
        id: 's4-p2',
        query: '我体检有什么异常',
        session: 's4-6',
        gold: ['s4-m2', 's4-m3'],
        expectLowMarked: ['s4-m2'],
        category: 'recall',
        why: '体检那条来源是观察，档位低要标注；医嘱那句是亲口说的'
      },
      {
        id: 's4-p3',
        query: '我还喝奶茶吗',
        session: 's4-6',
        gold: ['s4-m5'],
        expectLowMarked: ['s4-m5'],
        category: 'conflict',
        why: '有反对证据，必须封在低档'
      }
    ]
  },

  {
    id: 's5',
    title: '自建机房扩容',
    themes: ['项目', '工作'],
    sessions: [
      { id: 's5-1', day: -70, lines: ['我们在自建机房', '机房在城西的产业园里'] },
      { id: 's5-2', day: -50, lines: ['我们在自建机房'] },
      { id: 's5-3', day: -40, lines: ['运维只有我和老周两个人'] },
      { id: 's5-4', day: -25, lines: ['机房的电不够，在扩容', '我不打算再买新机柜'] },
      { id: 's5-5', day: -8, lines: ['我们在自建机房', '扩容完了，机柜都上架了'] },
      { id: 's5-6', day: -1, lines: ['机房现在什么进度', '机柜还买不买'] }
    ],
    memories: [
      memory('s5-m1', '我们在自建机房', 's5-1', -70, {
        context: 'technicalProject',
        type: 'project',
        supports: 3
      }),
      memory('s5-m2', '机房在城西的产业园里', 's5-1', -70, { context: 'technicalProject' }),
      memory('s5-m3', '运维只有我和老周两个人', 's5-3', -40, { supports: 1 }),
      memory('s5-m4', '机房的电不够，在扩容', 's5-4', -25, {
        context: 'technicalProject',
        type: 'project',
        supersededDay: -8,
        note: 's5-5 说扩容完了，这行被取代'
      }),
      memory('s5-m5', '我不打算再买新机柜', 's5-4', -25, {
        context: 'technicalProject',
        type: 'decision',
        note: '情境用 technicalProject 而不是 decisionMaking：后者默认要用户确认，而确认界面还没做，真实写侧今天落不进这一类'
      }),
      memory('s5-m6', '扩容完了，机柜都上架了', 's5-5', -8, { context: 'technicalProject', type: 'project', version: 2 })
    ],
    probes: [
      {
        id: 's5-p1',
        query: '机房现在什么进度',
        session: 's5-6',
        gold: ['s5-m6'],
        forbidden: ['s5-m4'],
        category: 'update',
        why: '扩容那件事的最新说法是「完了」，旧行已盖 supersededAt'
      },
      {
        id: 's5-p2',
        query: '机柜还买不买',
        session: 's5-6',
        gold: ['s5-m5'],
        category: 'recall',
        why: 's5-4 原话，是唯一一条讲买机柜的决定'
      },
      {
        id: 's5-p3',
        query: '机房在哪个位置',
        session: 's5-6',
        gold: ['s5-m2'],
        category: 'recall',
        why: 's5-1 原话'
      },
      {
        id: 's5-p4',
        query: '运维是谁在做',
        session: 's5-6',
        gold: ['s5-m3'],
        category: 'recall',
        why: 's5-3 原话；注意 s1-m5 里也有「组里新来的同事」这种说法，两者不该互串'
      }
    ]
  },

  {
    id: 's6',
    title: '那个 offer 要不要接',
    themes: ['决策'],
    sessions: [
      { id: 's6-1', day: -30, lines: ['我犹豫要不要留在现在的组', '另一家公司的 offer 我拿到了'] },
      { id: 's6-2', day: -20, lines: ['我答应下个月一号入职', '年假还剩五天没休'] },
      { id: 's6-3', day: -12, lines: ['我打算接那个 offer', '我犹豫要不要留在现在的组'] },
      { id: 's6-4', day: -6, lines: ['我答应下个月一号入职'] },
      { id: 's6-5', day: -4, lines: ['我跟主管提了离职'] },
      { id: 's6-6', day: -1, lines: ['我接下来去哪家公司', '离职的事提了吗'] }
    ],
    memories: [
      memory('s6-m1', '另一家公司的 offer 我拿到了', 's6-1', -30),
      memory('s6-m2', '我犹豫要不要留在现在的组', 's6-1', -30, {
        context: 'personalGoal',
        type: 'decision',
        contradicts: 1,
        note: 's6-5 提了离职，是对「还在犹豫」的反向证据；犹豫本身没有新说法覆盖，所以留着但压到低档'
      }),
      memory('s6-m3', '我打算接那个 offer', 's6-3', -12, { context: 'personalGoal', type: 'decision', supports: 1 }),
      memory('s6-m4', '我答应下个月一号入职', 's6-2', -20, { supports: 2 }),
      memory('s6-m5', '我跟主管提了离职', 's6-5', -4),
      memory('s6-m6', '年假还剩五天没休', 's6-2', -20, { origin: 'observed' })
    ],
    probes: [
      {
        id: 's6-p1',
        query: '我接下来去哪家公司',
        session: 's6-6',
        gold: ['s6-m1', 's6-m3'],
        category: 'recall',
        why: '决定接的那条是关键；「下个月一号入职」（s6-m4）也在答案里才完整，但它不指出是哪家'
      },
      {
        id: 's6-p2',
        query: '离职的事提了吗',
        session: 's6-6',
        gold: ['s6-m5'],
        category: 'recall',
        why: 's6-5 原话，最新的动作'
      },
      {
        id: 's6-p3',
        query: '我还在犹豫要不要留下吗',
        session: 's6-6',
        gold: ['s6-m2'],
        expectLowMarked: ['s6-m2'],
        category: 'conflict',
        why: '有反对证据的旧犹豫，必须以低可信标注出现，不能当作当前心态陈述'
      },
      {
        id: 's6-p4',
        query: '我的年假还有几天',
        session: 's6-6',
        gold: ['s6-m6'],
        expectLowMarked: ['s6-m6'],
        category: 'recall',
        why: '来源是观察，低档要标注'
      }
    ]
  },

  {
    id: 's7',
    title: '家里的事，只在那次对话里',
    themes: ['情绪'],
    sessions: [
      { id: 's7-1', day: -20, lines: ['我不想在对话里提家里的矛盾', '这周事情太多，有点累'] },
      { id: 's7-2', day: -15, lines: ['我最近睡眠不好', '入睡要一个小时'] },
      { id: 's7-3', day: -9, lines: ['我上班路上喜欢听播客', '财经类的少听，太吵'] },
      { id: 's7-4', day: -7, lines: ['我周末去公园走了走，感觉好一些'] },
      { id: 's7-5', day: -3, lines: ['我把看盘 App 的推送关了'] },
      { id: 's7-6', day: -1, lines: ['我和妈妈吵了一架，心里堵得慌'] },
      { id: 's7-7', day: -1, lines: ['上次说的那个心情不好的事，你还记得吗'] }
    ],
    memories: [
      memory('s7-m1', '我不想在对话里提家里的矛盾', 's7-1', -20, {
        context: 'emotionalSupport',
        note: '敏感情境默认只在当次对话，换会话就不该出现'
      }),
      memory('s7-m2', '我最近睡眠不好', 's7-2', -15, { context: 'emotionalSupport', type: 'emotion' }),
      memory('s7-m3', '我上班路上喜欢听播客', 's7-3', -9, { type: 'preference' }),
      memory('s7-m4', '财经类的少听，太吵', 's7-3', -9, { type: 'preference' }),
      memory('s7-m5', '我周末去公园走了走，感觉好一些', 's7-4', -7, { context: 'emotionalSupport', type: 'emotion' }),
      memory('s7-m6', '我把看盘 App 的推送关了', 's7-5', -3, { type: 'preference' }),
      memory('s7-m7', '我和妈妈吵了一架，心里堵得慌', 's7-6', -1, { context: 'emotionalSupport', type: 'emotion' })
    ],
    probes: [
      {
        id: 's7-p1',
        query: '我和妈妈吵架这事，你怎么看',
        session: 's7-6',
        gold: ['s7-m7'],
        category: 'recall',
        why: '同一次对话里问的，sessionOnly 的记忆这时候必须可见——过滤过头就是把用户正在说的话忘掉'
      },
      {
        id: 's7-p2',
        query: '上次说的那个心情不好的事，你还记得吗',
        session: 's7-7',
        gold: [],
        forbidden: ['s7-m7', 's7-m1', 's7-m2', 's7-m5'],
        category: 'forgetting',
        why: '换了一个会话，敏感情境的 sessionOnly 必须让这四条全部不可见，一条都不许进上下文'
      },
      {
        id: 's7-p3',
        query: '我上班路上干嘛来着',
        session: 's7-7',
        gold: ['s7-m3'],
        category: 'recall',
        why: 'general 情境长期保留，跨会话照旧可用'
      },
      {
        id: 's7-p4',
        query: '睡眠的事我之前提过吗',
        session: 's7-7',
        gold: [],
        forbidden: ['s7-m2'],
        category: 'forgetting',
        why: '睡眠那条记在 emotionalSupport 情境，换会话就该消失'
      }
    ]
  },

  {
    id: 's8',
    title: '周报、评审和那些「我把 X 做了一遍」',
    themes: ['工作'],
    sessions: [
      { id: 's8-1', day: -100, lines: ['我们的周报是周一早上交', '组内的代码评审由我和老周轮流做'] },
      { id: 's8-2', day: -60, lines: ['我每周五下午做技术分享'] },
      { id: 's8-3', day: -12, lines: ['我把周报改成了周五下班前交', '技术分享还是周五下午'] },
      { id: 's8-4', day: -4, lines: ['我把衣服洗了一遍', '我把桌面收拾了一遍'] },
      { id: 's8-5', day: -3, lines: ['我把地板拖了一遍', '我把碗筷洗了一遍'] },
      { id: 's8-6', day: -1, lines: ['周报什么时候交', '代码评审谁来做'] }
    ],
    memories: [
      memory('s8-m1', '我们的周报是周一早上交', 's8-1', -100, {
        version: 1,
        supersededDay: -12,
        note: 's8-3 用户自己改了规则'
      }),
      memory('s8-m2', '我把周报改成了周五下班前交', 's8-3', -12, { version: 2 }),
      memory('s8-m3', '组内的代码评审由我和老周轮流做', 's8-1', -100, { supports: 1 }),
      memory('s8-m4', '我每周五下午做技术分享', 's8-2', -60),
      memory('s8-m5', '我把衣服洗了一遍', 's8-4', -4),
      memory('s8-m6', '我把桌面收拾了一遍', 's8-4', -4),
      memory('s8-m7', '我把地板拖了一遍', 's8-5', -3),
      memory('s8-m8', '我把碗筷洗了一遍', 's8-5', -3)
    ],
    probes: [
      {
        id: 's8-p1',
        query: '周报什么时候交',
        session: 's8-6',
        gold: ['s8-m2'],
        forbidden: ['s8-m1'],
        category: 'update',
        why: '规则是用户自己改的，旧行已被取代；这条同时检验「周报」这种共享词没被句式噪声挤掉'
      },
      {
        id: 's8-p2',
        query: '代码评审谁来做',
        session: 's8-6',
        gold: ['s8-m3'],
        category: 'recall',
        why: 's8-1 原话；s5-m3「运维只有我和老周」共享一个人名，但不该被当成答案'
      },
      {
        id: 's8-p3',
        query: '我把桌面收拾了一遍吗',
        session: 's8-6',
        gold: ['s8-m6'],
        category: 'recall',
        why: '四条「我把 X 做了一遍」是切片 2 校准里那组句式噪声，词法上互相高度相似，专门用来压精确率'
      },
      {
        id: 's8-p4',
        query: '技术分享还做吗',
        session: 's8-6',
        gold: ['s8-m4'],
        category: 'recall',
        why: 's8-2 说过、s8-3 又确认了一次时间；两条都提周五，能测出「周五」这个共享词的分量'
      }
    ]
  }
];

/** 全部批次拼成一个池子：harness、报告和 snapshot 都只认这一个入口。 */
export const STORIES: EvalStory[] = [...CORE_STORIES, ...BATCH1_STORIES];

/** 一个用户的全部记忆行——线上 listMemories 给的就是「这个人的所有」，不是按故事切开的。 */
export function allMemories(): EvalMemory[] {
  return STORIES.flatMap((story) => story.memories);
}

export function allProbes(): Array<{ story: EvalStory; probe: EvalProbe }> {
  return STORIES.flatMap((story) => story.probes.map((probe) => ({ story, probe })));
}

export function allSessions(): Array<{ story: EvalStory; sessionId: string }> {
  return STORIES.flatMap((story) => story.sessions.map((sessionId) => ({ story, sessionId: sessionId.id })));
}
