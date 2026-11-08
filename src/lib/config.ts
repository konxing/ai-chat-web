import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export interface SystemSettings {
  siteName: string;
  registrationOpen: boolean;
  defaultProviderId: string | null;
  maxUploadMB: number;
  maintenanceNotice: string;
  /** AI 记忆审核开关（Phase 2）。数据库里没配过时回落到 env COGNITIVE_AI_MEMORY。 */
  cognitiveAiMemoryEnabled: boolean;
  /** 记忆审核用的独立模型；null = 跟随默认聊天模型。DB 没配过时回落 env COGNITIVE_AI_MEMORY_PROVIDER。 */
  cognitiveExtractionProviderId: string | null;
  /** 会话结束总结开关：对话闲置够久后把这一场记忆碎片收拢成要点，并与其它记忆查重。 */
  cognitiveSessionSummaryEnabled: boolean;
  /** 待确认自动裁决：记忆候选/决策/画像建议超过 24 小时没处理，交给审核模型判保留或丢弃。 */
  cognitiveAutoConfirmEnabled: boolean;
}

const DEFAULTS: SystemSettings = {
  siteName: '澄境 · Family AI',
  registrationOpen: false,
  defaultProviderId: null,
  maxUploadMB: 300,
  maintenanceNotice: '',
  cognitiveAiMemoryEnabled: false,
  cognitiveExtractionProviderId: null,
  cognitiveSessionSummaryEnabled: false,
  // 用户口径：待确认的东西一天没处理就交给 AI 定。默认开，后台可以关。
  cognitiveAutoConfirmEnabled: true
};

const ALLOWED_KEYS = new Set<keyof SystemSettings>([
  'siteName',
  'registrationOpen',
  'defaultProviderId',
  'maxUploadMB',
  'maintenanceNotice',
  'cognitiveAiMemoryEnabled',
  'cognitiveExtractionProviderId',
  'cognitiveSessionSummaryEnabled',
  'cognitiveAutoConfirmEnabled'
]);

function coerce<K extends keyof SystemSettings>(key: K, value: unknown): SystemSettings[K] {
  if (
    key === 'registrationOpen' ||
    key === 'cognitiveAiMemoryEnabled' ||
    key === 'cognitiveSessionSummaryEnabled' ||
    key === 'cognitiveAutoConfirmEnabled'
  ) {
    return Boolean(value) as SystemSettings[K];
  }
  if (key === 'maxUploadMB') {
    const n = Number(value);
    return (Number.isFinite(n) && n >= 1 && n <= 320 ? Math.floor(n) : DEFAULTS.maxUploadMB) as SystemSettings[K];
  }
  if (key === 'defaultProviderId' || key === 'cognitiveExtractionProviderId') {
    return (typeof value === 'string' && value.length > 0 ? value : null) as SystemSettings[K];
  }
  return (typeof value === 'string' ? value : DEFAULTS[key]) as SystemSettings[K];
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const rows = await prisma.systemConfig.findMany();
  const settings = { ...DEFAULTS };
  for (const row of rows) {
    if (!ALLOWED_KEYS.has(row.key as keyof SystemSettings)) continue;
    const key = row.key as keyof SystemSettings;
    // @ts-expect-error index assignment is safe because key is constrained above
    settings[key] = coerce(key, row.value);
  }
  return settings;
}

export async function getSystemSetting<K extends keyof SystemSettings>(key: K): Promise<SystemSettings[K]> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  return row ? coerce(key, row.value) : DEFAULTS[key];
}

/**
 * 原始读一行配置：行不存在返回 null（不回落 DEFAULTS）。给「数据库里没配过时回落 env」的场景用——
 * 老库已经 seed 过、新键还没有行，这时不能因为默认值把 env 顶掉。
 */
export async function getRawSystemSetting(key: string): Promise<unknown | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  return row ? row.value : null;
}

export async function updateSystemSettings(
  patch: Partial<SystemSettings>,
  updatedById: string | null
): Promise<SystemSettings> {
  const entries = Object.entries(patch).filter(([key]) => ALLOWED_KEYS.has(key as keyof SystemSettings));
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue, updatedById },
        update: { value: value as Prisma.InputJsonValue, updatedById }
      })
    )
  );
  return getSystemSettings();
}

export async function seedDefaultSettings(updatedById: string | null): Promise<void> {
  const existing = await prisma.systemConfig.count();
  if (existing === 0) {
    await updateSystemSettings(DEFAULTS, updatedById);
  }
}
