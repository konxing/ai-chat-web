import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export interface SystemSettings {
  siteName: string;
  registrationOpen: boolean;
  defaultProviderId: string | null;
  maxUploadMB: number;
  maintenanceNotice: string;
}

const DEFAULTS: SystemSettings = {
  siteName: '澄境 · Family AI',
  registrationOpen: false,
  defaultProviderId: null,
  maxUploadMB: 300,
  maintenanceNotice: ''
};

const ALLOWED_KEYS = new Set<keyof SystemSettings>([
  'siteName',
  'registrationOpen',
  'defaultProviderId',
  'maxUploadMB',
  'maintenanceNotice'
]);

function coerce<K extends keyof SystemSettings>(key: K, value: unknown): SystemSettings[K] {
  if (key === 'registrationOpen') return Boolean(value) as SystemSettings[K];
  if (key === 'maxUploadMB') {
    const n = Number(value);
    return (Number.isFinite(n) && n >= 1 && n <= 320 ? Math.floor(n) : DEFAULTS.maxUploadMB) as SystemSettings[K];
  }
  if (key === 'defaultProviderId') {
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
