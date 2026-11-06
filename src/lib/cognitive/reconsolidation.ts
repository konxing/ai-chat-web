import type { EvidenceKind } from './evidence';
import type { MemoryOrigin } from './memories';

/**
 * 再巩固检查（任务书 7.1「记忆被再次调用时，检查……」）。
 *
 * 任务书列了五项，这里只做三项，另外两项**判为无法验收，不发明**：
 *
 * | 检查 | 今天有没有 | 这一片 |
 * |---|---|---|
 * | 是否出现了新的支持信息 | 有：证据行带 createdAt，写侧 recordRestatement 会补 SUPPORTS | 做 |
 * | 是否出现了新的反例 | **行**有（reviseMemory 写 CONTRADICTS），**发现**没有 | 只报库里已有的行 |
 * | 是否已经过时 | 全有，读侧：validTo / supersededAt | 做 |
 * | 是否需要更新摘要 | 记忆摘要这个东西不存在（MemoryItem 没有摘要列） | 不做 |
 * | 是否需要修改关联关系 | 关系表有了（`MemoryRelation`，11-06 按 2.3 建），但**没有可自动判定的「该改」信号**——今天只有两种带证据的边由写侧自动生成，改哪条边是用户的判断 | 不做 |
 *
 * 「词法反例发现」同样不接进这一屏：docs/cognitive-acceptance.md:537-570 那次实测
 * 36 条候选 0 条真是反例，接上来只会产出一排假警报。
 *
 * 这一层是**纯函数**：输入是已经查回来的记忆列和证据条，输出是标记数组，不算分、不排序、不碰数据库，
 * 因此不可能长出第二份评分规则。标记只回答「这条值得回看一眼」，**不改变置信度**——
 * 置信度仍然只由 evidence.ts + confidence.ts 那一份算，任务书 7.1 那句
 * 「检索次数不能直接提高事实可信度、访问频率不能替代证据」靠这条边界守着。
 *
 * 测试：tests/unit/cognitive-reconsolidation.test.ts
 */

export type ReconsolidationFlag = 'newSupport' | 'contradiction' | 'outdated';

/** 只取检查要用的那几列：MemoryDto 的正文、来源消息 id 这里一个都不需要。 */
export interface ReviewSubject {
  id: string;
  origin: MemoryOrigin;
  /** 这条记忆当初记下来的时间——「新的」是相对它说的。 */
  recordedAt: string;
  validTo: string | null;
  supersededAt: string | null;
  /** 归档不是 MemoryDto 的列（读侧默认就排除），由调用方按自己所在的桶补上。 */
  archivedAt: string | null;
}

/** 一条证据里检查要看的两样。方向沿用证据账本自己的口径，不另立枚举。 */
export interface EvidenceStamp {
  kind: EvidenceKind;
  createdAt: string;
}

/**
 * 顺序固定写死在这里，不让界面自己排：三项同时成立时，
 * 「凭据变了」比「时间过了」更需要先看到，而三条都比没有标记强。
 */
const FLAG_ORDER: readonly ReconsolidationFlag[] = ['newSupport', 'contradiction', 'outdated'];

export function reviewMemory(
  subject: ReviewSubject,
  evidence: readonly EvidenceStamp[],
  now: Date = new Date()
): ReconsolidationFlag[] {
  // 三种终态不再回看：被取代的旧版本、归档的、撤回的，它们已经不是当前说法了，
  // 给它们挂「有新的支持信息」只会把用户的注意力引向一排不该再进提示词的行。
  if (subject.supersededAt || subject.archivedAt || subject.origin === 'retracted') return [];

  const flags: ReconsolidationFlag[] = [];
  const recordedAt = new Date(subject.recordedAt).getTime();
  if (evidence.some((item) => item.kind === 'supports' && new Date(item.createdAt).getTime() > recordedAt)) {
    flags.push('newSupport');
  }
  if (evidence.some((item) => item.kind === 'contradicts')) flags.push('contradiction');
  // 与 confidence.ts:72 同一个 `<=`：过期判定不留两处口径，否则一边说过时一边给分。
  if (subject.validTo !== null && new Date(subject.validTo).getTime() <= now.getTime()) flags.push('outdated');

  return FLAG_ORDER.filter((flag) => flags.includes(flag));
}

/**
 * 一屏一次算完。证据里缺席的记忆按**空数组**回，不是从结果里消失——
 * 「没有标记」和「没算」是两回事，少回一条界面就会少渲染一行。
 */
export function reviewMemories(
  subjects: readonly ReviewSubject[],
  evidenceByMemory: ReadonlyMap<string, readonly EvidenceStamp[]>,
  now: Date = new Date()
): Map<string, ReconsolidationFlag[]> {
  const reviews = new Map<string, ReconsolidationFlag[]>();
  for (const subject of subjects) {
    reviews.set(subject.id, reviewMemory(subject, evidenceByMemory.get(subject.id) ?? [], now));
  }
  return reviews;
}
