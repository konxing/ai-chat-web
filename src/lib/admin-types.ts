export interface AdminUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: 'OWNER' | 'USER';
  status: 'ACTIVE' | 'DISABLED';
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  chats: number;
  messages: number;
  activeSessions: number;
  providers: number;
}

export interface AdminIpRule {
  id: string;
  cidr: string;
  label: string;
  enabled: boolean;
  expiresAt: string | null;
  status: 'active' | 'expired' | 'disabled';
  createdBy: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLoginLock {
  ip: string;
  fails: number;
  firstFailAt: string;
  lockedUntil: string | null;
  updatedAt: string;
}

export interface ServiceStatus {
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  loadAverage: number[];
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    systemFreeBytes: number;
    systemTotalBytes: number;
  };
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
  database: { ok: boolean; latencyMs: number; sizeBytes: number | null; version: string | null };
  appUrl: string;
  nodeEnv: string;
  startedAt: string;
}

export interface AdminOverview {
  users: { total: number; active: number; disabled: number; owners: number };
  chats: { total: number; messages: number };
  storage: { attachments: number; bytes: number; uploadsBytes: number };
  models: { global: number; user: number; enabled: number };
  access: { rules: number; activeRules: number; sessions: number; logins24h: number; denied24h: number };
  service: ServiceStatus;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LoginLogItem {
  id: string;
  username: string;
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
  success: boolean;
  reason: string | null;
  createdAt: string;
}

export interface AuditLogItem {
  id: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface AccessLogItem {
  id: string;
  ip: string;
  method: string;
  path: string;
  allowed: boolean;
  reason: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface StorageBreakdown {
  total: { count: number; bytes: number };
  byUser: Array<{ userId: string; username: string; count: number; bytes: number }>;
}

export interface BackupMeta {
  file: string;
  createdAt: string | null;
  bytes: number;
  sha256: string | null;
  databaseBytes?: number;
  uploadsBytes?: number;
  uploadsSourceBytes?: number;
}
