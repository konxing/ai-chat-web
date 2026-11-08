import { getRawSystemSetting } from '@/lib/config';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { DEFAULT_CONVERSATION_STYLE, type ConversationStyle } from '../core/conversation-policy';

/**
 * 用户表达偏好（Phase 1 读取 / Phase 6 写入）。按用户严格隔离。
 *
 * 不建新表：存在 SystemConfig 的按用户键 `conversationStyle:<userId>`（JSON）。
 * 它只是一份风格配置，丢了最坏回到默认风格，不影响业务数据。
 * 读取时逐字段校验，坏值回落默认，绝不让一个脏配置把提示词带偏。
 */

export function styleSettingKey(userId: string): string {
  return `conversationStyle:${userId}`;
}

const ENUMS: Record<keyof ConversationStyle, readonly string[]> = {
  knowledgeDepth: ['low', 'medium', 'high'],
  naturalness: ['low', 'medium', 'high'],
  structure: ['minimal', 'dynamic', 'rich'],
  proactivity: ['low', 'medium', 'high'],
  restraint: ['low', 'medium', 'high'],
  length: ['short', 'dynamic', 'long'],
  factuality: ['standard', 'high']
};

export function sanitizeStyle(raw: unknown): ConversationStyle {
  const out = { ...DEFAULT_CONVERSATION_STYLE };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(ENUMS) as (keyof ConversationStyle)[]) {
    const value = obj[key];
    if (typeof value === 'string' && ENUMS[key].includes(value)) {
      // 逐字段赋值，类型由 ENUMS 约束保证。
      (out as Record<string, string>)[key] = value;
    }
  }
  return out;
}

export async function getConversationStyle(userId: string): Promise<ConversationStyle> {
  const raw = await getRawSystemSetting(styleSettingKey(userId)).catch(() => null);
  return sanitizeStyle(raw);
}

export async function setConversationStyle(userId: string, style: Partial<ConversationStyle>, source = 'user'): Promise<ConversationStyle> {
  const current = await getConversationStyle(userId);
  const next = sanitizeStyle({ ...current, ...style });
  await prisma.systemConfig.upsert({
    where: { key: styleSettingKey(userId) },
    create: { key: styleSettingKey(userId), value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue }
  });
  await prisma.systemConfig.upsert({
    where: { key: styleMetaKey(userId) },
    create: { key: styleMetaKey(userId), value: { updatedAt: new Date().toISOString(), source } as unknown as Prisma.InputJsonValue },
    update: { value: { updatedAt: new Date().toISOString(), source } as unknown as Prisma.InputJsonValue }
  });
  return next;
}

/** P3：偏好元数据（来源/最近修改），供偏好页展示与撤销。 */
export function styleMetaKey(userId: string): string {
  return `conversationStyleMeta:${userId}`;
}
export async function getConversationStyleMeta(userId: string): Promise<{ updatedAt: string | null; source: string | null }> {
  const raw = await getRawSystemSetting(styleMetaKey(userId)).catch(() => null);
  if (!raw || typeof raw !== 'object') return { updatedAt: null, source: null };
  const obj = raw as Record<string, unknown>;
  return { updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null, source: typeof obj.source === 'string' ? obj.source : null };
}

/** P3：恢复默认=删除本人风格与元数据键，回到 DEFAULT_CONVERSATION_STYLE。 */
export async function resetConversationStyle(userId: string): Promise<ConversationStyle> {
  await prisma.systemConfig.deleteMany({ where: { key: { in: [styleSettingKey(userId), styleMetaKey(userId)] } } });
  return { ...DEFAULT_CONVERSATION_STYLE };
}
