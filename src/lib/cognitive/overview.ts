import { prisma } from '@/lib/prisma';
import { DECISION_LIST_MAX_ROWS } from './decisions';
import { countPendingCandidates } from './memory-candidates';
import { MEMORY_LIST_MAX_ROWS, toDbMemoryOrigin } from './memories';
import { MEMORY_CONTEXTS } from './policy';
import { getCognitivePreferences, type CognitivePreferences } from './preferences';
import { PROFILE_LIST_MAX_ROWS } from './user-profile';
import { REFLECTION_LIST_MAX_ROWS } from './reflections';

/**
 * 认知中心的门厅（任务书 8.2 那一屏「个人认知中心」的后端）。
 *
 * 这里没有新数据，也没有新真相：八张表全别的屏已经在读，这一层只是把它们各数一次，
 * 端成一屏七个入口。所以它自己只有两种犯假话的方式，这片的全部代码都在防这两种：
 *
 * 一、**为了凑一个「0」去数关着的模块的行**。任务书 8.3 那句「关闭模块后，不能继续执行
 *     对应的数据读取」是服务端口径，门厅不是例外。每张关着的表一次 `count` 都不发，
 *     返回的那一行也没有数字，只有 `OVERVIEW_SECTION_OFF` 那句「没打开」。
 *     闸门逐字对齐各屏路由自己的 409 条件：记忆网络和时间线是长期记忆的派生视图，两道闸；
 *     洞察、决策、画像各一道；而记忆管理和策略那两屏按片L 的裁决**不吃任何开关**——
 *     关掉长期记忆不该让已经存下的东西看不见、删不掉，那两屏的数因此照发。
 *     偏好读不出来时，这五屏按关处理（拿不准就不数），那两屏照数（它们本来就没看偏好）。
 *
 * 二、**数字与点进去看到的不一致**。两条来源：`enabled` 必须等于那一屏真实的可进入状态；
 *     各屏列表有自己的行数上限（洞察/决策 100，记忆/画像 200），数到 101 却只说「101 条」，
 *     用户点进去只能看到 100 条，就会以为少掉的那 1 条没发生过——所以超上限时那句话自己带上
 *     「这一屏只列出最近 N 条」。上限直接引用各屏导出的那一个常量，不在这里抄第二遍。
 *
 * 出去的形状只有 `key / enabled / detail` 三个字段：正文一列都不读，也就没有解密，
 * 没有标题、没有原话、没有 id。中文标签归界面（它才知道自己链到哪个 tab）。
 */

/** 关着的那几屏唯一被允许出现的那句话。 */
export const OVERVIEW_SECTION_OFF = '这道闸没打开；打开后这里才会读取你的记忆内容';

export type OverviewSectionKey =
  | 'graph'
  | 'timeline'
  | 'reflections'
  | 'decisions'
  | 'profile'
  | 'memory'
  | 'policy';

export interface OverviewSection {
  key: OverviewSectionKey;
  enabled: boolean;
  detail: string;
}

export interface CognitiveOverview {
  sections: OverviewSection[];
  preferencesUnavailable: boolean;
}

export async function getCognitiveOverview(userId: string): Promise<CognitiveOverview> {
  const gates = await readGates(userId);

  const graphOn = enabled(gates.flags, 'associationEnabled') && enabled(gates.flags, 'memoryEnabled');
  const timelineOn = enabled(gates.flags, 'timelineEnabled') && enabled(gates.flags, 'memoryEnabled');
  const reflectionsOn = enabled(gates.flags, 'reflectionEnabled');
  const decisionsOn = enabled(gates.flags, 'decisionMemoryEnabled');
  const profileOn = enabled(gates.flags, 'userModelEnabled');

  const [
    activeMemories,
    pendingCandidates,
    touchedPolicies,
    revisions,
    citationEdges,
    reflections,
    decisions,
    profiles
  ] = await Promise.all([
      // 「当前有效」和记忆那一屏的默认口径同一条 where：同一个数在两个地方必须数出同一批行。
      prisma.memoryItem.count({
        where: {
          userId,
          origin: { notIn: [toDbMemoryOrigin('retracted')] },
          archivedAt: null,
          supersededAt: null
        }
      }),
      countPendingCandidates(userId),
      prisma.memoryPolicy.count({ where: { userId } }),
      timelineOn ? prisma.memoryRevision.count({ where: { userId } }) : null,
      graphOn ? prisma.reflectionCitation.count({ where: { userId } }) : null,
      reflectionsOn ? prisma.reflectionRecord.count({ where: { userId } }) : null,
      decisionsOn ? prisma.decisionRecord.count({ where: { userId } }) : null,
      profileOn ? prisma.userProfileEntry.count({ where: { userId } }) : null
    ]);

  const memoryDetail =
    `${countPhrase(activeMemories, MEMORY_LIST_MAX_ROWS, '条当前有效的记忆')}` +
    `，另有 ${pendingCandidates} 条等你确认`;

  return {
    preferencesUnavailable: gates.unavailable,
    sections: [
      {
        key: 'graph',
        enabled: graphOn,
        detail: gated(graphOn, `${citationEdges ?? 0} 条共引用边`)
      },
      {
        key: 'timeline',
        enabled: timelineOn,
        detail: gated(timelineOn, `${revisions ?? 0} 条改口记录`)
      },
      {
        key: 'reflections',
        enabled: reflectionsOn,
        detail: gated(reflectionsOn, countPhrase(reflections ?? 0, REFLECTION_LIST_MAX_ROWS, '条洞察'))
      },
      {
        key: 'decisions',
        enabled: decisionsOn,
        detail: gated(decisionsOn, countPhrase(decisions ?? 0, DECISION_LIST_MAX_ROWS, '条决策记录'))
      },
      {
        key: 'profile',
        enabled: profileOn,
        detail: gated(profileOn, countPhrase(profiles ?? 0, PROFILE_LIST_MAX_ROWS, '条画像'))
      },
      {
        key: 'memory',
        enabled: true,
        detail: memoryDetail
      },
      {
        key: 'policy',
        enabled: true,
        detail: `${touchedPolicies} / ${MEMORY_CONTEXTS.length} 个情境改过设置，其余走内置默认`
      }
    ]
  };
}

/** 读一次偏好；读不到就是「不知道」，调用方按关处理。 */
async function readGates(userId: string): Promise<{ flags: Partial<CognitivePreferences>; unavailable: boolean }> {
  try {
    return { flags: await getCognitivePreferences(userId), unavailable: false };
  } catch {
    return { flags: {}, unavailable: true };
  }
}

function enabled(flags: Partial<CognitivePreferences>, key: keyof CognitivePreferences): boolean {
  return flags[key] === true;
}

function gated(on: boolean, detail: string): string {
  return on ? detail : OVERVIEW_SECTION_OFF;
}

/** 数本身，加一句它会被那一屏的行数上限截断——只说前者是一张会说谎的门厅。 */
function countPhrase(total: number, cap: number, unit: string): string {
  return total > cap ? `${total} ${unit}（这一屏只列出最近 ${cap} 条）` : `${total} ${unit}`;
}
