import type { Prisma, ReflectionCitationKind, ReflectionRecord, ReflectionStatus, ReflectionType } from '@prisma/client';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';
import { prisma } from '@/lib/prisma';
import { decryptDecisionTopic } from './decisions';
import { cognitiveColumnAad } from './encrypted-columns';
import { decryptMemoryContent } from './memories';
import type { ConfidenceBand } from './confidence';
import { confidenceBandOf } from './reflection-evidence';
import { getCognitivePreferences } from './preferences';

/**
 * 洞察的读侧与状态机（任务书 6.4 的六个状态、6.6 的限量、7.4 的门槛 7）。
 *
 * 6-D 只管把洞察写进库，这一片管让它**被人看见并被人处置**。三件事的形状是有理由的：
 *
 * 一、「过期」在这里也算一遍，不等后台来盖章。sweep 一天最多跑一次，而那 30 天的
 *    `expiresAt` 说的是「这条洞察作为一条**待处理**的提醒值 30 天」——如果只有收割才判，
 *    过期的一天里它照样摆在最显眼的位置。库里那一行还是 PENDING（生产者仍然是 sweep 的收割，
 *    门槛 7 要的是「有人写得出这个状态」，不是「只有读侧知道它」），读侧的派生只是同一条规则提前显示。
 * 二、状态机的入口只有 PENDING：`where` 里带着它，所以并发两次采纳只有第一次命中。
 *    和决策确认（decisions.ts 的 setDecisionStatus）是同一个协议，不是一个新发明。
 * 三、**采纳一个字都不多写**（6-B 立项时定下的甲方案）：ACCEPTED 只翻状态。它不是「用户说过
 *    这句话」，把系统推断写成一条记忆或画像，就是让机器替用户承认了他没承认的事；那条记忆
 *    还要反过来变成下一次反思的证据，洞察于是开始自我喂养。这一条禁令在
 *    tests/unit/cognitive-reflection-states.test.ts 里钉成静态断言，不靠这段注释。
 *
 * 密文的 AAD 绑的是那一行的 id，所以 edit 是**就地重新加密**（同一个 id、同一套字段名），
 * 而不是新建一行：换了 id，库里那三段老密文就再也解不开了。改完之后系统原来的措辞不保留——
 * 用户改过的那份才是这条洞察现在的样子，留一份原稿等于多存一份没人负责的用户隐私。
 *
 * 日志口径同 6-D：只有 id、状态和计数，正文一次都不进日志。
 *
 * 测试：tests/unit/cognitive-reflections-service.test.ts（行为）、
 * tests/unit/cognitive-reflections-route.test.ts（路由闸门）、
 * tests/unit/cognitive-reflection-states.test.ts（门槛 7 与两条禁令）。
 */
export const REFLECTION_LIST_MAX_ROWS = 100;

/**
 * 6.6「第一版最多保留 3 条待确认的高价值洞察作为主要展示」——这个数字直接抄任务书，
 * 不在这里另设阈值：尺子用的是 sweep 落库时那条 `importance`（`reflection-sweep.ts:473`），
 * 也就是「哪三条值得写进库」和「哪三条摆在最上面」是同一把尺子的两次用途。
 */
export const PRIMARY_DISPLAY_MAX = 3;

/** 「稍后」只有三档：任意天数会让 snooze 变成「无限期推迟」的入口。 */
export type ReflectionSnoozeDays = 3 | 7 | 30;

const DAY_MS = 86_400_000;

const aadFor = (userId: string, id: string, column: string) =>
  cognitiveColumnAad('ReflectionRecord', column, userId, id);

export interface ReflectionDto {
  id: string;
  type: ReflectionType;
  /** 六个状态里 PENDING 是「此刻还值得摆出来」，EXPIRED 可能是读出来的（见文件头第一条）。 */
  status: ReflectionStatus;
  title: string;
  body: string;
  /** 竞争解释（任务书 6.3）：规则分不出几种解释时列出来的那几份，没有就是 null。 */
  alternatives: string | null;
  /**
   * 档位，不是分数（片Q-3）。库里那列是 `0.62` 这种三位小数，它是规则的产物不是测量值，
   * 出到服务端就会被读成精确真理——记忆屏 1b 早定了同一个口径：分数不出服务端。
   * 换算只有一条规则：`confidenceBandOf`，与写侧措辞用的那一条是同一个函数。
   */
  confidenceBand: ConfidenceBand;
  /**
   * 「主要展示」那三条之一（6.6）。额度是 3、尺子是库里那列 `importance`，两样都只在
   * `listReflections` 里用一次：界面拿到的是布尔，不是那个 0–1 的数——这和片Q-3 的
   * 「分数不出服务端」是同一条口径，而且界面自己排一次序，就会和服务端选出的三条分叉。
   *
   * 单条读恒为 false：那里只有一行，「前三」在一行的列表上没有意义。
   */
  isPrimary: boolean;
  sampleCount: number;
  observationSpanDays: number;
  counterHitCount: number;
  timeFrom: string | null;
  timeTo: string | null;
  timePrecision: string;
  generatedAt: string;
  expiresAt: string | null;
  snoozedUntil: string | null;
  decidedAt: string | null;
}

/** 反证搜索用的关键词不进 DTO：它是正文的派生物，读侧和界面都不需要它。 */
function toDto(row: ReflectionRecord, now: Date): ReflectionDto {
  const plain = (column: string, ciphertext: string | null) =>
    ciphertext === null ? null : decryptString(ciphertext, aadFor(row.userId, row.id, column));
  return {
    id: row.id,
    type: row.type,
    status: deriveStatus(row, now),
    title: decryptString(row.titleCiphertext, aadFor(row.userId, row.id, 'titleCiphertext')),
    body: decryptString(row.bodyCiphertext, aadFor(row.userId, row.id, 'bodyCiphertext')),
    alternatives: plain('alternativesCiphertext', row.alternativesCiphertext),
    confidenceBand: confidenceBandOf(row.confidence),
    isPrimary: false,
    sampleCount: row.sampleCount,
    observationSpanDays: row.observationSpanDays,
    counterHitCount: row.counterHitCount,
    timeFrom: row.timeFrom?.toISOString() ?? null,
    timeTo: row.timeTo?.toISOString() ?? null,
    timePrecision: row.timePrecision,
    generatedAt: row.generatedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null
  };
}

/**
 * 读出来的状态：过期的判成 EXPIRED，稍后到期的判回 PENDING。
 *
 * 稍后这一档必须在这儿判而不是只靠 sweep 的收割，因为 6.6 的冷却现在可调：收割排在闸门之后，
 * 一天一轮时「稍后 3 天」最多迟到一天，调成每月以后同一句「稍后」会静默变成「稍后一个月」。
 * 到期用 `<=`，和收割那句 `snoozedUntil: { lte: now }` 同一个口径。
 * 顺序是有意 TTL 在前：一条 `expiresAt` 已过的稍后洞察过期就是过期，不因「稍后」也到了就续命。
 */
function deriveStatus(row: ReflectionRecord, now: Date): ReflectionStatus {
  const status =
    row.status === 'SNOOZED' && row.snoozedUntil !== null && row.snoozedUntil.getTime() <= now.getTime()
      ? 'PENDING'
      : row.status;
  if (status === 'PENDING' && row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return status;
}

/**
 * 两道闸门一次读一遍偏好。
 * `reflectionEnabled` 管「能不能看洞察」，`memoryEnabled` 管「能不能解密那一行 MemoryItem」——
 * 单条详情的证据就是记忆原文，所以派生视图不能成为绕过长期记忆开关的后门（任务书 1.1）。
 * 列表和动作只碰 ReflectionRecord 自己的列，用不到后一道。
 */
export async function reflectionGates(userId: string): Promise<{ reflectionEnabled: boolean; memoryEnabled: boolean }> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return {
      reflectionEnabled: preferences.reflectionEnabled === true,
      memoryEnabled: preferences.memoryEnabled === true
    };
  } catch {
    return { reflectionEnabled: false, memoryEnabled: false };
  }
}

/** 偏好读不出来按关闭处理，和 timeline / decisions 同一个口径。 */
export async function reflectionModuleEnabled(userId: string): Promise<boolean> {
  return (await reflectionGates(userId)).reflectionEnabled;
}

/**
 * 列表。`state` 过滤发生在**派生之后**，所以它只能在应用层做：派生出来的 EXPIRED 没有对应的列值，
 * 用 SQL 的 `status = 'PENDING'` 过滤会把「库里还是 PENDING、但已经过期」的那几行放进来。
 *
 * 主要展示的标记也在这一层算，而且是**过滤之前**算——6.6 那三条额度说的是「这一屏端出来前三条」，
 * 界面切个状态标签不该把额度重新分配一次。判定用的是 `deriveStatus` 的结果而不是库里的列，
 * 否则一条过期但还没被 sweep 收割的 PENDING 会占掉一个位置，把三条还活着的全挤下去。
 */
export async function listReflections(
  userId: string,
  input: { now: Date; state?: ReflectionStatus }
): Promise<ReflectionDto[]> {
  const rows = await prisma.reflectionRecord.findMany({
    where: { userId },
    orderBy: { generatedAt: 'desc' },
    take: REFLECTION_LIST_MAX_ROWS
  });
  const entries = rows.map((row) => ({ dto: toDto(row, input.now), importance: row.importance }));
  return input.state === undefined
    ? markPrimaryDisplay(entries)
    : markPrimaryDisplay(entries).filter((dto) => dto.status === input.state);
}

/**
 * 待处理整块排在其余状态之前，块内按重要度高的在前；其余状态维持「生成时间新的在前」——
 * 那个顺序是 SQL 给的，这里不重排。
 *
 * 同分时按生成时间新的在前，再同则按 id：`sort` 在现代引擎里是稳定的，但稳定不等于两次调用同序
 * （SQL 只保证 generatedAt 一列的次序），而「同一批数据两次点进来看到不同的前三条」正是这片要防的。
 */
function markPrimaryDisplay(
  entries: ReadonlyArray<{ dto: ReflectionDto; importance: number }>
): ReflectionDto[] {
  const pending = entries
    .filter((entry) => entry.dto.status === 'PENDING')
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        Date.parse(b.dto.generatedAt) - Date.parse(a.dto.generatedAt) ||
        (a.dto.id < b.dto.id ? -1 : 1)
    );
  pending.forEach((entry, index) => {
    entry.dto.isPrimary = index < PRIMARY_DISPLAY_MAX;
  });
  const others = entries.filter((entry) => entry.dto.status !== 'PENDING');
  return [...pending, ...others].map((entry) => entry.dto);
}

export interface ReflectionCitationDto {
  id: string;
  kind: ReflectionCitationKind;
  memoryId: string | null;
  decisionId: string | null;
  /** 证据那句原话。源行已经不在了（用户删了那条记忆）就是 null——门槛 4 要的是说不出，不是编一句。 */
  text: string | null;
}

/**
 * 单条洞察和它的证据。引用行按 kind 原样带回，正文按需解密：
 * 一次读只解这一条洞察引用的那几行，不为「一屏三条」把整个记忆池解一遍。
 */
export async function getReflectionWithCitations(
  userId: string,
  id: string,
  input: { now: Date }
): Promise<{ reflection: ReflectionDto; citations: ReflectionCitationDto[] } | null> {
  const row = await prisma.reflectionRecord.findFirst({ where: { id, userId } });
  if (!row) return null;

  const citations = await prisma.reflectionCitation.findMany({
    where: { userId, reflectionId: id },
    orderBy: { createdAt: 'asc' }
  });
  const memoryIds = [...new Set(citations.map((c) => c.memoryId).filter((v): v is string => v !== null))];
  const decisionIds = [...new Set(citations.map((c) => c.decisionId).filter((v): v is string => v !== null))];
  const [memories, decisions] = await Promise.all([
    memoryIds.length === 0
      ? Promise.resolve([])
      : prisma.memoryItem.findMany({ where: { userId, id: { in: memoryIds } } }),
    decisionIds.length === 0
      ? Promise.resolve([])
      : prisma.decisionRecord.findMany({ where: { userId, id: { in: decisionIds } } })
  ]);
  const textByMemoryId = new Map(
    memories.map((memory) => [memory.id, decryptMemoryContent(memory, userId)])
  );
  const topicByDecisionId = new Map(
    decisions.map((decision) => [decision.id, decryptDecisionTopic(decision, userId)])
  );

  return {
    reflection: toDto(row, input.now),
    citations: citations.map((citation) => ({
      id: citation.id,
      kind: citation.kind,
      memoryId: citation.memoryId,
      decisionId: citation.decisionId,
      text:
        citation.memoryId !== null
          ? textByMemoryId.get(citation.memoryId) ?? null
          : citation.decisionId !== null
            ? topicByDecisionId.get(citation.decisionId) ?? null
            : null
    }))
  };
}

export type ReflectionActionInput =
  | { action: 'accept'; now: Date }
  | { action: 'reject'; now: Date }
  | { action: 'snooze'; now: Date; days: ReflectionSnoozeDays }
  | { action: 'edit'; now: Date; title: string; body: string };

/** 改写的长度上限：正文不许比系统写出来的还短（措辞最多带三句原话，每句上限 1000 字）。 */
const REFLECTION_TITLE_MAX_CHARS = 200;
const REFLECTION_BODY_MAX_CHARS = 4000;

function validateEdited(field: 'title' | 'body', value: string): string {
  const limit = field === 'title' ? REFLECTION_TITLE_MAX_CHARS : REFLECTION_BODY_MAX_CHARS;
  const text = value.trim();
  if (text === '') throw new ApiError(400, 'VALIDATION_ERROR', `洞察${field === 'title' ? '标题' : '正文'}不能为空`);
  if (text.length > limit) throw new ApiError(400, 'VALIDATION_ERROR', `不能超过 ${limit} 字`);
  return text;
}

/**
 * 用户动作。状态机只有一个入口状态，读侧判出来的过期在这里同样生效——
 * 否则界面已经藏起来的行还能被一次迟到请求改掉，两边各说一套。
 */
export async function setReflectionStatus(
  userId: string,
  id: string,
  input: ReflectionActionInput
): Promise<ReflectionDto> {
  const { now } = input;
  const row = await prisma.reflectionRecord.findFirst({ where: { id, userId } });
  if (!row) throw new ApiError(404, 'REFLECTION_NOT_FOUND', '这条洞察不存在');
  const status = deriveStatus(row, now);
  if (status === 'EXPIRED') throw new ApiError(409, 'REFLECTION_EXPIRED', '这条洞察已经过期了');
  if (status !== 'PENDING') {
    throw new ApiError(409, 'REFLECTION_ALREADY_DECIDED', '这条洞察已经处理过了，不能再改');
  }

  const data = columnsFor(userId, id, input);
  // 条件更新带的是预检同一套口径：库里还是 PENDING，或者 SNOOZED 且到期（预检把那条派生成 PENDING）。
  // 少第二支，界面上点得动的按钮在这里永远 409；整个去掉状态条件，并发抢输时就会覆盖别人刚写的状态。
  const updated = await prisma.reflectionRecord.updateMany({
    where: {
      id,
      userId,
      OR: [{ status: 'PENDING' }, { status: 'SNOOZED', snoozedUntil: { lte: now } }]
    },
    data
  });
  if (updated.count === 0) {
    // 抢输了：另一次动作在同一瞬间把状态翻走了。条件 UPDATE 只命中一次，这是它的正确结果。
    throw new ApiError(409, 'REFLECTION_ALREADY_DECIDED', '这条洞察已经处理过了，不能再改');
  }
  const after = await prisma.reflectionRecord.findFirst({ where: { id, userId } });
  return toDto(after!, now);
}

/** 四个动作各写哪几列。全在这里，方便一眼看出「采纳没有碰任何别的表」。 */
function columnsFor(
  userId: string,
  id: string,
  input: ReflectionActionInput
): Prisma.ReflectionRecordUpdateManyMutationInput {
  switch (input.action) {
    case 'accept':
      return { status: 'ACCEPTED', decidedAt: input.now };
    case 'reject':
      return { status: 'REJECTED', decidedAt: input.now };
    case 'snooze':
      return {
        status: 'SNOOZED',
        decidedAt: input.now,
        snoozedUntil: new Date(input.now.getTime() + input.days * DAY_MS)
      };
    case 'edit':
      return {
        status: 'EDITED',
        decidedAt: input.now,
        titleCiphertext: encryptString(validateEdited('title', input.title), aadFor(userId, id, 'titleCiphertext')),
        bodyCiphertext: encryptString(validateEdited('body', input.body), aadFor(userId, id, 'bodyCiphertext'))
      };
  }
}
