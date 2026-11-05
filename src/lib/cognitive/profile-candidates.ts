import type { ReflectionStatus } from '@prisma/client';
import type { MemoryContext, MemoryPolicy } from './policy';
import type { MemoryOrigin } from './memories';
import { PROFILE_CANDIDATE_MEMORY_NOTE, PROFILE_CANDIDATE_REFLECTION_NOTE } from './user-profile-display';

/**
 * 画像候选的派生（任务书 8.2 / 8.3）。**纯函数，不碰数据库。**
 *
 * 这个约束不是风格。画像条目是「用户确认过的东西」，而候选是「系统觉得可以让他确认一下的东西」——
 * 两者之间只隔着用户那一次点击。如果派生层能写库，那扇门上就没有锁了，
 * 所以这里连 prisma 都不 import（tests/unit/cognitive-user-model.test.ts 把它断成静态断言）。
 *
 * 三条规则的形状：
 *
 * 一、**只有你已经说过或确认过的记忆**能成为候选（explicit / userConfirmed）。
 * 系统观察到的、推断出来的、还只是假设的，都不许直接摆进画像候选——那是洞察的活，
 * 而洞察要成为画像，得先被用户采纳过一次。这条线是「AI 不能把自己的推断凌驾于用户的真实表达之上」
 * 在画像上的形态。
 * 二、**来源情境关着门，派生品不许从旁边绕过去。**allowUserProfile 是用户说的「这类东西别整理进画像」，
 * 于是一条洞察只要引用了任何一个关掉的情境，它就不成为候选。一条引用都没有的洞察同样不提议：
 * 追溯不到来源的话，摆出来只是让用户替系统承认一句没凭据的推断。
 * 三、**已经收进画像的那条记忆不再回头问第二遍。**用户确认过一次的来源记在条目上，
 * 天天回来问同一件事会让这个面板变成一个永远清不完的待办。
 */

const CONFIRMED_ORIGINS: readonly MemoryOrigin[] = ['explicit', 'userConfirmed'];
const ACCEPTED_STATUSES: readonly ReflectionStatus[] = ['ACCEPTED', 'EDITED'];

export interface ProfileCandidateSource {
  id: string;
  context: MemoryContext;
  origin: MemoryOrigin;
  content: string;
}

export interface ProfileReflectionSource {
  id: string;
  status: ReflectionStatus;
  title: string;
  /** 这条洞察引用的那些记忆**各自的情境**；没有引用行就是空数组。 */
  citedContexts: readonly MemoryContext[];
}

export interface ProfileCandidateInput {
  memories: readonly ProfileCandidateSource[];
  reflections: readonly ProfileReflectionSource[];
  policies: Record<MemoryContext, MemoryPolicy>;
  /** 已经是某条画像条目来源的那些记忆 id——确认过的东西不再重复提议。 */
  profiledMemoryIds: ReadonlySet<string>;
}

export interface ProfileCandidate {
  from: 'memory' | 'reflection';
  content: string;
  /** 逐字标注，界面上原样显示——措辞住在 user-profile-display.ts，两边共用一份。 */
  note: string;
  sourceMemoryIds: string[];
  sourceReflectionIds: string[];
}

function allowsProfile(policies: Record<MemoryContext, MemoryPolicy>, context: MemoryContext): boolean {
  return policies[context]?.allowUserProfile === true;
}

/**
 * 候选清单：你先说过的在前，系统推断的在后。
 *
 * 不排序成「置信度高的在前」是有意的——置信度是洞察自己的属性，而在这里它只会把
 * 「系统觉得这条更可能对」变成摆在最显眼位置的压力，用户面对的仍然是一次确认。
 */
export function deriveProfileCandidates(input: ProfileCandidateInput): ProfileCandidate[] {
  const fromMemories: ProfileCandidate[] = [];
  for (const memory of input.memories) {
    if (!CONFIRMED_ORIGINS.includes(memory.origin)) continue;
    if (input.profiledMemoryIds.has(memory.id)) continue;
    if (!allowsProfile(input.policies, memory.context)) continue;
    fromMemories.push({
      from: 'memory',
      content: memory.content,
      note: PROFILE_CANDIDATE_MEMORY_NOTE,
      sourceMemoryIds: [memory.id],
      sourceReflectionIds: []
    });
  }

  const fromReflections: ProfileCandidate[] = [];
  for (const reflection of input.reflections) {
    if (!ACCEPTED_STATUSES.includes(reflection.status)) continue;
    if (reflection.citedContexts.length === 0) continue;
    if (!reflection.citedContexts.every((context) => allowsProfile(input.policies, context))) continue;
    fromReflections.push({
      from: 'reflection',
      content: reflection.title,
      note: PROFILE_CANDIDATE_REFLECTION_NOTE,
      sourceMemoryIds: [],
      sourceReflectionIds: [reflection.id]
    });
  }

  return [...fromMemories, ...fromReflections];
}
