/**
 * 画像的界面词表（任务书 8.2 / 8.3）。
 *
 * 单独一份、且只放常量，是因为服务端和浏览器要**逐字同一句**：候选派生在服务端算出标注，
 * 面板把同一句原样摆出来。两边的措辞一旦各写一份，「系统推断」和「你亲口说的」这两种东西
 * 在界面上就会开始长得差不多——那正是这套设计最不能出错的区分。
 *
 * 这个文件不许 import 任何运行时模块（policy.ts / memories.ts / user-profile.ts 顶层都带 prisma）。
 * 静态断言在 tests/unit/cognitive-user-model.test.ts。
 */

/** 候选的底子是你说过或确认过的记忆，但「把它整理进画像」这个动作仍是系统提出的，所以要你再确认一次。 */
export const PROFILE_CANDIDATE_MEMORY_NOTE = '来自你已经说过或确认过的记忆，收不收进画像由你确认';

/**
 * 候选来自洞察，而洞察是系统的推断（任务书 6.4）。这句标注必须逐字出现在界面上——
 * 采纳一条洞察不等于用户说过这句话，画像条目更不能替用户承认他没承认的事。
 */
export const PROFILE_CANDIDATE_REFLECTION_NOTE = '系统推断，未经你确认';

/** 画像一屏上「这句话后来被改过」的说法。改动时刻由条目自己带，这里只出措辞。 */
export const PROFILE_EDITED_LABEL = '（改过）';

/**
 * 列表被 `PROFILE_LIST_MAX_ROWS` 截断时的说明，口径和洞察、记忆那两屏一样：
 * 条数取**实际列出的行数**，不把服务端常量抄一份到界面。不说出来，
 * 「这里没有更早的」就会被读成「更早的没发生过」。
 */
export function describeProfileCap(capped: boolean, shownCount: number): string {
  if (!capped) return '';
  return `画像条目比这一屏多：这里只列出最近 ${shownCount} 条，更早的没有读进来。`;
}

/** 确认时刻到日为止：这一列本来就是「哪天点的确认」，时分秒摆出来只是让一行变吵。 */
export function describeConfirmedAt(confirmedAt: string): string {
  const date = new Date(confirmedAt);
  return `确认于 ${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

/**
 * 条目自带的依据说一句话。两份数组都是空的（用户亲笔写的那条）就返回空串——
 * 「依据：0 条记忆」是一句没有信息量的话，而亲笔那条本来就不需要依据。
 * 这里只报条数，不报 id：id 在界面上解不出标题，摆出来只是让用户对着一段 UUID。
 */
export function describeEntrySources(
  memoryIds: readonly string[],
  reflectionIds: readonly string[]
): string {
  const parts: string[] = [];
  if (memoryIds.length > 0) parts.push(`${memoryIds.length} 条记忆`);
  if (reflectionIds.length > 0) parts.push(`${reflectionIds.length} 条洞察`);
  return parts.length === 0 ? '' : `依据：${parts.join(' · ')}`;
}
