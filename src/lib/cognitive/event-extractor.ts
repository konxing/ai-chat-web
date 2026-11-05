import { COMPLETION_MARKERS } from './reflection-planner';
import type { ChangeObservation } from './change-detector';
import type { TimelineEvent } from './timeline';

/**
 * 任务书 4.1 的 EventExtractor——但它不生产事件，只给事件起名。
 *
 * 时间线上的一条事件已经是 `deriveTimelineEvents` 算出来的了（一行记忆或一条版本链的头）。
 * 这一层做的事情只有一件：判它属于 4.1 那 12 类里的哪一类，一类到底。
 * 之所以不做成「第二个事件生成器」，是因为那样同一屏上会并排站着两条流水账——
 * 一条按记忆行排，一条按抽出来的事件排，它们对同一个昨天的说法可以不一样。
 * 那种矛盾不是 bug，是用户同一天看到两个世界。
 *
 * 三条判据的来源全部是已经审过的东西，这里一个新判据都不立：
 * 一、「完成」用 6.1/4.3 同一张 `COMPLETION_MARKERS`，而且和 4.3 的 `chainSignal` 一样
 *    只在版本链上算——第一版里带一句「我完成了…」不是一次到达，那只是第一次提到。
 * 二、「兴趣出现 / 转移」直接继承 4.3 的观察，不在这里重做主题相似度：
 *    4-T3 量过，词法相似度在中文语料上 0/36。
 * 三、「是不是新版本」看 `version`，不看这一批里折叠到几行：`historyCount` 会被 200 行上限吃掉，
 *    而 `version` 是写侧改口时递增出来的，跟这一批读回什么无关。
 *
 * 12 类里有 3 类这一层一条也不生成，`UNEMITTED_EVENT_KINDS` 把这件事写成数据而不是注释：
 * `DECISION_MADE` 的出处在 Phase 5 的 `DecisionRecord`（那边才有「待确认的候选连决策都还不算」
 * 那个确认状态，记忆行里的 `decision` 类型只是「系统记得你说过这句话」）；
 * `MILESTONE` 归 6.1，而 6.1 的 MILESTONE 恰好由「目标完成」和「决策落定」两件事构成——
 * 在这一层再发一份就是同一个事实的第三种说法；`CHALLENGE` 在库里没有任何一列记过它。
 * 宁可少 3 类，也不替用户把他没说过的经历补出来。
 *
 * 零模型调用、零数据库、零 crypto：输入是调用方已经读好的行和观察。
 *
 * 测试：tests/unit/cognitive-event-extractor.test.ts
 */

/** 任务书 4.1 逐字列出的 12 类，顺序也照它那份清单。封闭集合：多一类少一类都编译不过。 */
export const EVENT_KINDS = [
  'EXPERIENCE',
  'GOAL_CREATED',
  'GOAL_CHANGED',
  'GOAL_COMPLETED',
  'INTEREST_EMERGED',
  'INTEREST_SHIFTED',
  'PREFERENCE_CHANGED',
  'PROJECT_STARTED',
  'PROJECT_UPDATED',
  'MILESTONE',
  'CHALLENGE',
  'DECISION_MADE'
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** 这一层不生成的三类。界面要用它说一句「这屏只有 9 类」，所以它是数据，不是文档里的一句话。 */
export const UNEMITTED_EVENT_KINDS: readonly EventKind[] = ['DECISION_MADE', 'MILESTONE', 'CHALLENGE'];

/** 时间线那条事件加上一个类别。除 `kind` 以外一个字段都不动，顺序也不动。 */
export interface CognitiveEvent extends TimelineEvent {
  kind: EventKind;
}

export interface EventKindSource {
  events: readonly TimelineEvent[];
  /** 4.3 的观察。只有 `subject === 'INTEREST'` 的那几条会被读，别的主题一条也不影响分类。 */
  observations: readonly ChangeObservation[];
}

export function annotateEventKinds({ events, observations }: EventKindSource): CognitiveEvent[] {
  const emerged = new Set<string>();
  const shifted = new Set<string>();
  for (const observation of observations) {
    if (observation.subject !== 'INTEREST') continue;
    // 只站在新那一侧：旧那一簇有它自己的事件，跟着变成「兴趣转移」就把两件事算成了三件。
    if (observation.change === 'EMERGED') {
      for (const id of observation.afterMemoryIds) emerged.add(id);
    } else if (observation.change === 'SHIFTED') {
      for (const id of observation.afterMemoryIds) shifted.add(id);
    }
  }

  return events.map((event) => ({ ...event, kind: kindOf(event, emerged, shifted) }));
}

/**
 * 一类到底。顺序就是优先级：版本链上的说法比簇算出来的「兴趣」更具体，
 * 所以目标 / 项目 / 改过口的偏好先走完，剩下没有更强说法的行才轮到兴趣两类，
 * 最后落进「一段经历」。
 */
function kindOf(event: TimelineEvent, emerged: ReadonlySet<string>, shifted: ReadonlySet<string>): EventKind {
  const isNewerVersion = event.version > 1;
  switch (event.category) {
    case 'goal':
      if (!isNewerVersion) return 'GOAL_CREATED';
      return COMPLETION_MARKERS.some((marker) => event.content.includes(marker)) ? 'GOAL_COMPLETED' : 'GOAL_CHANGED';
    case 'project':
      return isNewerVersion ? 'PROJECT_UPDATED' : 'PROJECT_STARTED';
    case 'preference':
      if (isNewerVersion) return 'PREFERENCE_CHANGED';
      break;
    default:
      // `fact` / `emotion` / `decision`：没有更具体的说法，`decision` 也不冒充决策事件，见文件头第三条。
      break;
  }
  // 4.3 造不出同一行既在 EMERGED 又在 SHIFTED 的观察（转移过的那两个簇会被跳过），
  // 这个先后只是给异常数据兜底的收尾，不是第二种判据。
  if (emerged.has(event.memoryId)) return 'INTEREST_EMERGED';
  if (shifted.has(event.memoryId)) return 'INTEREST_SHIFTED';
  return 'EXPERIENCE';
}
