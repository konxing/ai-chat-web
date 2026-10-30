import type { User } from '@prisma/client';
import { getSystemSettings } from './config';

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    emailVerified: !!user.emailVerified,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null
  };
}

export function adminUser(user: User, counts?: { chats: number; messages: number; attachments: number }) {
  return {
    ...publicUser(user),
    updatedAt: user.updatedAt.toISOString(),
    counts: counts ?? null
  };
}

export async function publicSettings() {
  const settings = await getSystemSettings();
  return {
    siteName: settings.siteName,
    registrationOpen: settings.registrationOpen,
    maxUploadMB: settings.maxUploadMB,
    maintenanceNotice: settings.maintenanceNotice
  };
}
