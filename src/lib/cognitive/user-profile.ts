import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/http';
import { decryptString, encryptString } from '@/lib/crypto';

/**
 * 用户画像条目（任务书 8.2 的写侧与读侧）。
 *
 * 这一份文件只有一个存在理由：**把「库里只存你确认过的」做成结构**。
 * 做法是不给「不确认」留任何入口——
 * `ProfileEntryInput` 里没有 `confirmedAt` 这个字段，确认时间是服务在 `create` 那一刻自己盖章的；
 * 表上这一列不可空、迁移里没有 DEFAULT；没确认的候选只在纯函数层现算，进不了这张表。
 * 于是「未经确认不得建立画像」不是一句谁都要记得判的约定，而是一个编译期就递不进去的参数。
 *
 * 正文跟记忆同等对待：用户的话，密文落库，AAD 绑住 `userId + 行 id + 字段名`。
 * 来源 id 两个数组是**你确认那一刻的依据**，是一个时间戳式的事实，不是活指针：
 * 用户之后忘记某条记忆时，这里既不跟着删，也不事后被改写（src/lib/cognitive/forgetting.ts 一行都不碰这张表）。
 * 解析不出来的 id 就让它解析不出来——界面不许把「认不出的来源」美化成「有来源」。
 */
export const PROFILE_CONTENT_MAX_CHARS = 1000;

/** 画像一屏最多带回多少条：每行都要解密，上限由服务拿，调用方放开不了。 */
export const PROFILE_LIST_MAX_ROWS = 200;

/** 来源数组是客户端能递进来的列，库层管不了长度，所以在入口封顶。 */
const PROFILE_SOURCE_MAX_IDS = 20;

const aadFor = (userId: string, id: string) => `user-profile:v1:${userId}:${id}:content`;

interface ProfileRow {
  id: string;
  userId: string;
  contentCiphertext: string;
  sourceMemoryIds: string[];
  sourceReflectionIds: string[];
  confirmedAt: Date;
  editedAt: Date | null;
}

/** 写入入参：没有 confirmedAt，也不许加。测试断的就是这个形状（cognitive-user-profile.test.ts）。 */
export interface ProfileEntryInput {
  userId: string;
  content: string;
  sourceMemoryIds?: readonly string[];
  sourceReflectionIds?: readonly string[];
}

export interface ProfileEntryDto {
  id: string;
  content: string;
  sourceMemoryIds: string[];
  sourceReflectionIds: string[];
  confirmedAt: string;
  editedAt: string | null;
}

export function decryptProfileEntryContent(
  entry: Pick<ProfileRow, 'id' | 'userId' | 'contentCiphertext'>,
  viewerUserId: string
): string {
  if (entry.userId !== viewerUserId) throw new ApiError(403, 'FORBIDDEN', '这条画像条目不属于当前用户');
  return decryptString(entry.contentCiphertext, aadFor(entry.userId, entry.id));
}

function validateContent(content: string): string {
  const text = content.trim();
  if (!text) throw new ApiError(400, 'VALIDATION_ERROR', '画像正文不能为空');
  if (text.length > PROFILE_CONTENT_MAX_CHARS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `画像正文不能超过 ${PROFILE_CONTENT_MAX_CHARS} 字，请拆成多条`);
  }
  return text;
}

/** 原样留、去重、封顶——不解释、不校验那些 id 存不存在：来源是不是真的，界面自己会认不出来。 */
function validateSourceIds(ids: readonly string[] | undefined, label: string): string[] {
  const cleaned = [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
  if (cleaned.length > PROFILE_SOURCE_MAX_IDS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}来源最多 ${PROFILE_SOURCE_MAX_IDS} 条`);
  }
  return cleaned;
}

/** 解不开的那一行不拖垮整屏：正文位置换成一句实话，别的条目照常读。 */
function toDto(row: ProfileRow, viewerUserId: string): ProfileEntryDto {
  let content: string;
  try {
    content = decryptProfileEntryContent(row, viewerUserId);
  } catch {
    content = '（画像条目解密失败）';
  }
  return {
    id: row.id,
    content,
    sourceMemoryIds: row.sourceMemoryIds,
    sourceReflectionIds: row.sourceReflectionIds,
    confirmedAt: row.confirmedAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null
  };
}

export async function createProfileEntry(input: ProfileEntryInput): Promise<ProfileEntryDto> {
  const content = validateContent(input.content);
  const id = randomUUID();
  const row = (await prisma.userProfileEntry.create({
    data: {
      id,
      userId: input.userId,
      contentCiphertext: encryptString(content, aadFor(input.userId, id)),
      sourceMemoryIds: validateSourceIds(input.sourceMemoryIds, '记忆'),
      sourceReflectionIds: validateSourceIds(input.sourceReflectionIds, '洞察'),
      // 走到这一行就意味着刚刚发生了一次确认，所以时间只能在此刻取，不接受外面递进来的值。
      confirmedAt: new Date(),
      editedAt: null
    }
  })) as unknown as ProfileRow;
  return toDto(row, input.userId);
}

/**
 * 改正文重写同一行，不新开一条。
 *
 * 为什么不像记忆那样做版本链：记忆会被系统改口、要被时间线追溯、要能回滚成「那个说法」；
 * 画像条目只有「你确认过这句话」和「你刚刚把它改成这句」两个状态，中间那次说法一旦丢了就丢了，
 * 但它从来不是事实的来源——来源是原会话。开一条 revision 表换不来任何能被追问的东西。
 *
 * `confirmedAt` 故意不动：第一次确认是来源事实，改过的时刻另有 `editedAt` 记着。
 */
export async function reviseProfileEntry(input: {
  userId: string;
  id: string;
  content: string;
}): Promise<ProfileEntryDto> {
  const content = validateContent(input.content);
  const found = await prisma.userProfileEntry.findFirst({ where: { id: input.id, userId: input.userId } });
  if (!found) throw new ApiError(404, 'PROFILE_NOT_FOUND', '这条画像条目不属于当前用户，或者已经不存在');
  const previous = found as unknown as ProfileRow;

  // 归属写在条件里，不是写在 if 里：别人的行这条 UPDATE 命中 0 行。
  const stamped = await prisma.userProfileEntry.updateMany({
    where: { id: previous.id, userId: input.userId },
    data: { contentCiphertext: encryptString(content, aadFor(input.userId, previous.id)), editedAt: new Date() }
  });
  if (stamped.count === 0) throw new ApiError(404, 'PROFILE_NOT_FOUND', '这条画像条目已经不存在');

  const updated = await prisma.userProfileEntry.findFirst({ where: { id: previous.id, userId: input.userId } });
  if (!updated) throw new ApiError(404, 'PROFILE_NOT_FOUND', '这条画像条目已经不存在');
  return toDto(updated as unknown as ProfileRow, input.userId);
}

export async function deleteProfileEntry(userId: string, id: string): Promise<boolean> {
  const deleted = await prisma.userProfileEntry.deleteMany({ where: { id, userId } });
  return deleted.count > 0;
}

/** 画像一屏那个明确的清空入口——它是唯一能批量删这张表的地方，跟记忆的任何忘记路径都无关。 */
export async function clearProfileEntries(userId: string): Promise<number> {
  const deleted = await prisma.userProfileEntry.deleteMany({ where: { userId } });
  return deleted.count;
}

/**
 * 一屏的列表，和注入用的「最近几条」共用一个读法。
 *
 * `limit` 是调用方能收紧、不能放宽的那道闸：画像模块每轮对话都要读，
 * 而它只端 6 条——不带上限就是每轮解密 200 行，为一屏准备的开销不该被对话路径付。
 */
export async function listProfileEntries(userId: string, limit?: number): Promise<ProfileEntryDto[]> {
  const rows = await prisma.userProfileEntry.findMany({
    where: { userId },
    orderBy: { confirmedAt: 'desc' },
    take: Math.min(limit ?? PROFILE_LIST_MAX_ROWS, PROFILE_LIST_MAX_ROWS)
  });
  return (rows as unknown as ProfileRow[]).map((row) => toDto(row, userId));
}
