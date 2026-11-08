import type { ProfileEntryDto } from './user-profile';
import { scoreByKeyword } from './retrieval';

/**
 * 上下文相关画像只来自已确认的 UserProfileEntry。
 * 先按当前问题相关性选取，其余最多补两条近期背景。
 * 此处只排序，不创建或修改任何用户画像数据。
 */
export const PROFILE_SELECTION_POOL = 48;
export const PROFILE_CONTEXT_FALLBACK_ITEMS = 2;
export const PROFILE_RELEVANCE_MIN = 0.12;

export function selectRelevantProfileEntries(
  query: string,
  entries: readonly ProfileEntryDto[],
  limit: number
): ProfileEntryDto[] {
  if (entries.length === 0 || limit <= 0) return [];

  const recent = [...entries].sort((a, b) =>
    b.confirmedAt.localeCompare(a.confirmedAt) || a.id.localeCompare(b.id)
  );
  const ranked = scoreByKeyword(query, recent.map((entry) => ({
    entry,
    content: entry.content,
    recordedAt: entry.editedAt ?? entry.confirmedAt
  })));
  const relevant = ranked
    .filter(({ score }) => score >= PROFILE_RELEVANCE_MIN)
    .slice(0, limit)
    .map(({ memory }) => memory.entry);

  // Relevant entries stay first. Unrelated entries cannot consume all six slots.
  const fallbackLimit = Math.min(PROFILE_CONTEXT_FALLBACK_ITEMS, limit - relevant.length);
  const selectedIds = new Set(relevant.map((entry) => entry.id));
  let added = 0;
  for (const entry of recent) {
    if (added >= fallbackLimit) break;
    if (selectedIds.has(entry.id)) continue;
    relevant.push(entry);
    selectedIds.add(entry.id);
    added += 1;
  }
  return relevant;
}
