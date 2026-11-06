import { decryptString } from '@/lib/crypto';
import { cognitiveColumnAad } from './encrypted-columns';
import { prisma } from '@/lib/prisma';
import {
  listCitationEdges,
  listMemories,
  listMemoryContextsByIds,
  MEMORY_LIST_MAX_ROWS,
  type MemoryDto
} from './memories';
import { getMemoryPolicies, type MemoryContext } from './policy';
import { deriveProfileCandidates, type ProfileCandidate, type ProfileCandidateSource, type ProfileReflectionSource } from './profile-candidates';
import { getCognitivePreferences } from './preferences';
import { listProfileEntries, PROFILE_LIST_MAX_ROWS, type ProfileEntryDto } from './user-profile';

/**
 * 画像一屏的读侧组装（任务书 8.2 / 8.3）。
 *
 * 规则本身（哪来源能成为候选、哪一路被情境闸门挡住）住在 `profile-candidates.ts` 那份纯函数里。
 * 这一份只干三件事：按开关去读、把密文解开、把行交给纯函数。它的价值全在**读的次序**上：
 *
 * 一、闸门在所有读之前。这一屏要解三种密文（画像正文、记忆正文、洞察标题），
 *    `memoryEnabled` 晚一步就等于给关了长期记忆的用户整屏解密（任务书 1.1）。
 * 二、画像条目**不受**来源开关影响。它是你确认过的东西，不是派生记录：关掉长期记忆之后
 *    这一屏照样看得见、改得掉、删得掉，只是不再端出新的候选。
 * 三、候选的两路都要读 `MemoryItem`——一路读正文，一路读被引用那几行的**情境列**——
 *    所以「长期记忆关着」这一条同时挡住两路。
 * 四、引用行**残缺就不提议**。共引用边那份读有 200 行上限，被截掉的那一条如果正好属于一个关着的情境，
 *    拿残缺的清单去过闸门等于让派生品从旁边绕过去；解析不出来的来源也一样。宁可少列，不美化。
 *
 * 这一片**不 import 洞察那一屏的读侧模块**：`cognitive-reflection-states.test.ts` 把那条路径扫遍 `src`，
 * 除那两条洞察路由之外，任何文件里出现这个模块名都会红——连注释都不行，所以这里连提它的名字都只能绕着写。
 * 代价是洞察标题的 AAD 式子抄了一份，
 * 于是 `tests/unit/cognitive-profile-reads.test.ts` 把两边的式子钉成同一个——改了任何一边都会红。
 */

/** 洞察标题的密文式子。和 `reflections.ts` 里那一句逐字相同，由用例钉住。 */
const reflectionTitleAad = (userId: string, id: string) =>
  cognitiveColumnAad('ReflectionRecord', 'titleCiphertext', userId, id);

/** 候选只从采纳过的洞察来，所以读的是那一小批；上限和洞察那一屏同口径，不复用它的常量是因为那份 import 被钉住了。 */
const PROFILE_CANDIDATE_REFLECTION_MAX_ROWS = 100;

/** 采纳与改过：只有这两种状态的洞察可以作为画像候选（`profile-candidates.ts` 规则一的另一半）。 */
const ACCEPTED_STATUSES = ['ACCEPTED', 'EDITED'] as const;

export interface ProfileGates {
  userModelEnabled: boolean;
  memoryEnabled: boolean;
  reflectionEnabled: boolean;
}

export interface ProfileScreen {
  entries: ProfileEntryDto[];
  /** 读满 200 行要说明：这一屏不翻页，「这里没有更早的」不能替用户下结论。 */
  entriesCapped: boolean;
  candidates: ProfileCandidate[];
}

/**
 * 三道闸门一次读完偏好。读不出来按全关处理，和时间线、洞察、记忆网络同一个口径——
 * 拿不准的时候宁可什么都不做，尤其这一屏解的是密文。
 */
export async function profileGates(userId: string): Promise<ProfileGates> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return {
      userModelEnabled: preferences.userModelEnabled === true,
      memoryEnabled: preferences.memoryEnabled === true,
      reflectionEnabled: preferences.reflectionEnabled === true
    };
  } catch {
    return { userModelEnabled: false, memoryEnabled: false, reflectionEnabled: false };
  }
}

export async function readProfileScreen(
  userId: string,
  now: Date,
  gates: ProfileGates
): Promise<ProfileScreen> {
  const entries = await listProfileEntries(userId);
  const candidates = gates.memoryEnabled ? await readCandidates(userId, now, gates, entries) : [];
  return { entries, entriesCapped: entries.length >= PROFILE_LIST_MAX_ROWS, candidates };
}

async function readCandidates(
  userId: string,
  now: Date,
  gates: ProfileGates,
  entries: readonly ProfileEntryDto[]
): Promise<ProfileCandidate[]> {
  // 确认过的来源不再重复提议：那份 id 清单就挂在画像条目自己身上，不用另建一张表。
  const profiledMemoryIds = new Set(entries.flatMap((entry) => entry.sourceMemoryIds));
  const [memories, reflections, policies] = await Promise.all([
    listMemories(userId, { asOf: now }),
    readReflectionSources(userId, gates),
    getMemoryPolicies(userId)
  ]);
  return deriveProfileCandidates({
    memories: memories.map(toCandidateMemory),
    reflections,
    policies,
    profiledMemoryIds
  });
}

function toCandidateMemory(memory: MemoryDto): ProfileCandidateSource {
  return { id: memory.id, context: memory.context, origin: memory.origin, content: memory.content };
}

/**
 * 洞察那一路的来源。开关关着时连一次查询都不发。
 *
 * 标题解不开的那一条直接不摆：界面上宁可少列一条候选，也不摆一句编出来的话（门槛 4）。
 */
async function readReflectionSources(userId: string, gates: ProfileGates): Promise<ProfileReflectionSource[]> {
  if (!gates.reflectionEnabled) return [];
  const rows = await prisma.reflectionRecord.findMany({
    where: { userId, status: { in: [...ACCEPTED_STATUSES] } },
    orderBy: { generatedAt: 'desc' },
    take: PROFILE_CANDIDATE_REFLECTION_MAX_ROWS,
    select: { id: true, status: true, titleCiphertext: true }
  });
  if (rows.length === 0) return [];

  const edges = await listCitationEdges(userId);
  // 引用清单被截断过，闸门就建立在残缺的事实上：这一路整条不提议，而不是猜被掉的那一条属于哪个情境。
  if (edges.length >= MEMORY_LIST_MAX_ROWS) return [];
  const contextsById = await listMemoryContextsByIds(
    userId,
    [...new Set(edges.map((edge) => edge.memoryId))]
  );

  const cited = new Map<string, MemoryContext[]>();
  const incomplete = new Set<string>();
  for (const edge of edges) {
    const context = contextsById.get(edge.memoryId);
    if (context === undefined) {
      // 引用指向一条已经不存在的记忆：这条洞察的来源说不清，不提议（规则四）。
      incomplete.add(edge.reflectionId);
      continue;
    }
    const list = cited.get(edge.reflectionId);
    if (list) list.push(context);
    else cited.set(edge.reflectionId, [context]);
  }

  const sources: ProfileReflectionSource[] = [];
  for (const row of rows) {
    if (incomplete.has(row.id)) continue;
    const citedContexts = cited.get(row.id);
    let title: string;
    try {
      title = decryptString(row.titleCiphertext, reflectionTitleAad(userId, row.id));
    } catch {
      continue;
    }
    sources.push({
      id: row.id,
      status: row.status,
      title,
      citedContexts: citedContexts ?? []
    });
  }
  return sources;
}
