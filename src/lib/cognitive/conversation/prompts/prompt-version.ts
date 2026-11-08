import { randomUUID } from 'node:crypto';
import { getRawSystemSetting } from '@/lib/config';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

/**
 * 提示词版本管理（Phase 1 基础 / Phase 8 评测后上线）。不建新表：
 * 版本数组存 SystemConfig `conversationPromptVersions`，生效 id 存 `conversationPromptActive`。
 *
 * 规则：更新不覆盖历史；候选（candidate）必须经评测才能 activate；activate 旧版本即回滚。
 * content 版本化的是"全局交流原则 + 知识策略"这一段；模式/示例/用户风格仍由 builder 动态附加。
 */

export type PromptVersionStatus = 'active' | 'candidate' | 'archived';

export interface PromptVersion {
  id: string;
  version: number;
  content: string;
  applicableMode: string; // 'all' 或具体模式
  modelCompatibility: string; // 'all' 或 provider 名
  createdAt: string;
  evaluationScore: number | null;
  status: PromptVersionStatus;
}

const VERSIONS_KEY = 'conversationPromptVersions';
const ACTIVE_KEY = 'conversationPromptActive';

async function readVersions(): Promise<PromptVersion[]> {
  const raw = await getRawSystemSetting(VERSIONS_KEY).catch(() => null);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PromptVersion => Boolean(item) && typeof item === 'object' && typeof (item as PromptVersion).id === 'string');
}

async function writeVersions(versions: PromptVersion[]): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key: VERSIONS_KEY },
    create: { key: VERSIONS_KEY, value: versions as unknown as Prisma.InputJsonValue },
    update: { value: versions as unknown as Prisma.InputJsonValue }
  });
}

export async function listPromptVersions(): Promise<PromptVersion[]> {
  const versions = await readVersions();
  return versions.sort((a, b) => b.version - a.version);
}

/**
 * P3/F-09：applicableMode/modelCompatibility 真正参与选择。
 * 不传 ctx 时保持旧行为（按 active id/status）；传 ctx 时只选适用当前模式/Provider 的版本。
 */
export async function getActivePromptVersion(ctx?: { mode?: string; provider?: string }): Promise<PromptVersion | null> {
  const activeId = await getRawSystemSetting(ACTIVE_KEY).catch(() => null);
  const versions = await readVersions();
  const applies = (v: PromptVersion) =>
    (!ctx?.mode || v.applicableMode === 'all' || v.applicableMode === ctx.mode) &&
    (!ctx?.provider || v.modelCompatibility === 'all' || v.modelCompatibility === ctx.provider);
  if (typeof activeId === 'string') {
    const found = versions.find((v) => v.id === activeId);
    if (found && applies(found)) return found;
  }
  return versions.find((v) => v.status === 'active' && applies(v)) ?? null;
}

/** 新增候选版本（不生效）。version 自增。 */
export async function addCandidatePromptVersion(input: {
  content: string;
  applicableMode?: string;
  modelCompatibility?: string;
}): Promise<PromptVersion> {
  const versions = await readVersions();
  const nextVersion = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const entry: PromptVersion = {
    id: randomUUID(),
    version: nextVersion,
    content: input.content,
    applicableMode: input.applicableMode ?? 'all',
    modelCompatibility: input.modelCompatibility ?? 'all',
    createdAt: new Date().toISOString(),
    evaluationScore: null,
    status: 'candidate'
  };
  await writeVersions([...versions, entry]);
  return entry;
}

/** 记录评测分（不改变状态）。 */
export async function scorePromptVersion(id: string, score: number): Promise<void> {
  const versions = await readVersions();
  const next = versions.map((v) => (v.id === id ? { ...v, evaluationScore: score } : v));
  await writeVersions(next);
}

/** 生效某版本（回滚=激活旧版本）。被替换的 active 归档。 */
export async function activatePromptVersion(id: string): Promise<PromptVersion> {
  const versions = await readVersions();
  const target = versions.find((v) => v.id === id);
  if (!target) throw new Error('PROMPT_VERSION_NOT_FOUND');
  const next = versions.map((v) => {
    if (v.id === id) return { ...v, status: 'active' as const };
    if (v.status === 'active') return { ...v, status: 'archived' as const };
    return v;
  });
  await writeVersions(next);
  await prisma.systemConfig.upsert({
    where: { key: ACTIVE_KEY },
    create: { key: ACTIVE_KEY, value: id },
    update: { value: id }
  });
  return { ...target, status: 'active' };
}
