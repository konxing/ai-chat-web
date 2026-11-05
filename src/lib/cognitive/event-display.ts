import type { EventKind } from './event-extractor';

/**
 * 任务书 4.1 那 12 类事件的展示词汇。
 *
 * 单独成一个纯模块的理由和 `change-display.ts` 一样：`event-extractor.ts` 那条链上挂着
 * `reflection-planner`，而它背后是 prisma 的枚举。客户端组件只要几个标签，
 * 直接引用检测层就会把数据库驱动拖进浏览器包，所以这里只有一个 `import type`。
 *
 * 两张表分工写死：`EVENT_KIND_LABELS` 是 12 类的全称表（含这一层不生成的那 3 类——
 * 界面要能回答「为什么这一屏只有 9 类」，那 3 个名字必须先存在），
 * `FILTERABLE_EVENT_KINDS` 才是筛选用的那一排。两者的差由
 * tests/unit/cognitive-event-display.test.ts 逐字钉住，不靠这里记得住。
 *
 * 标签只做一件事：说出这是哪一类事。「目标完成」不是「你终于把事做成了」，
 * 一个字的形容都不加——任务书不许根据少数记录生成确定性人格结论，
 * 那条红线同样适用于类别的名字，所以名字表里没有「典型」「说明你是」这类词。
 *
 * 测试：tests/unit/cognitive-event-display.test.ts
 */

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  EXPERIENCE: '一段经历',
  GOAL_CREATED: '定下目标',
  GOAL_CHANGED: '目标改了说法',
  GOAL_COMPLETED: '目标完成',
  INTEREST_EMERGED: '新提起的事',
  INTEREST_SHIFTED: '兴趣转移',
  PREFERENCE_CHANGED: '偏好改了说法',
  PROJECT_STARTED: '新项目',
  PROJECT_UPDATED: '项目更新',
  MILESTONE: '里程碑',
  CHALLENGE: '一项挑战',
  DECISION_MADE: '一个决定'
};

/**
 * 筛选那一排的 9 类，顺序照任务书那份清单。
 * 「兴趣转移」和「里程碑」这两个词与洞察那一屏（`reflection-display.ts`）用字相同：
 * 同一个事实换两种说法，用户就会怀疑其中一个是随手写的。
 */
export const FILTERABLE_EVENT_KINDS: readonly EventKind[] = [
  'EXPERIENCE',
  'GOAL_CREATED',
  'GOAL_CHANGED',
  'GOAL_COMPLETED',
  'INTEREST_EMERGED',
  'INTEREST_SHIFTED',
  'PREFERENCE_CHANGED',
  'PROJECT_STARTED',
  'PROJECT_UPDATED'
];

/** 这一屏少的那 3 类说在哪一句里——空着不写等于让用户自己猜系统不懂什么。 */
export const UNEMITTED_EVENT_KIND_NOTE =
  '12 类事件里这一屏生成 9 类。「一个决定」和「里程碑」的出处在「决策」和「洞察」那两屏，' +
  '那里才有确认过的状态；「一项挑战」在现有记录里没有对应的列。宁可少 3 类，也不替你补出没说过的经历。';

export function describeEventKind(kind: EventKind): string {
  return EVENT_KIND_LABELS[kind];
}
