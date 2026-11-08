import { prisma } from '@/lib/prisma';
import { getRawSystemSetting } from '@/lib/config';
import type { ProfileCandidate } from './profile-candidates';

/**
 * 画像建议的「已忽略」名单。
 *
 * 画像建议是每次读侧从记忆/洞察派生出来的，不是表里的待确认行——AI 判「丢弃」时必须落一个标记，
 * 否则那条建议下一屏又摆回来，等于没处理。标记按用户存在 SystemConfig 的一个键里（JSON 字符串数组），
 * 不建表、不加列：它只是一份过滤名单，不是业务数据，丢了最坏结果也只是旧建议重新露出来。
 *
 * 键的形状：`profileDismissed:<userId>` → ["memory:<id>", "reflection:<id>", ...]。
 */

/** 建议的稳定键：优先来源记忆，其次来源洞察，最后退回内容前缀（内容只用于兜底，不做哈希）。 */
export function profileCandidateKey(
  candidate: Pick<ProfileCandidate, 'content' | 'sourceMemoryIds' | 'sourceReflectionIds'>
): string {
  if (candidate.sourceMemoryIds.length > 0) return `memory:${candidate.sourceMemoryIds[0]}`;
  if (candidate.sourceReflectionIds.length > 0) return `reflection:${candidate.sourceReflectionIds[0]}`;
  return `text:${candidate.content.slice(0, 60)}`;
}

export function profileDismissedSettingKey(userId: string): string {
  return `profileDismissed:${userId}`;
}

export async function readDismissedProfileKeys(userId: string): Promise<Set<string>> {
  const raw = await getRawSystemSetting(profileDismissedSettingKey(userId)).catch(() => null);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((item): item is string => typeof item === 'string'));
}

export async function addDismissedProfileKeys(userId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const current = await readDismissedProfileKeys(userId);
  for (const key of keys) current.add(key);
  const value = [...current];
  await prisma.systemConfig.upsert({
    where: { key: profileDismissedSettingKey(userId) },
    create: { key: profileDismissedSettingKey(userId), value },
    update: { value }
  });
}
