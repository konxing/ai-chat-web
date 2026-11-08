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

export async function setConversationStyle(userId: string, style: Partial<ConversationStyle>): Promise<ConversationStyle> {
  const current = await getConversationStyle(userId);
  const next = sanitizeStyle({ ...current, ...style });
  await prisma.systemConfig.upsert({
    where: { key: styleSettingKey(userId) },
    create: { key: styleSettingKey(userId), value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue }
  });
  return next;
}
