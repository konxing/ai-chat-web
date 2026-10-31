import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import { prisma } from './prisma';
import { loadEnv } from './env';
import { ApiError, getRequestIp, getUserAgent } from './http';
import { writeAudit } from './audit';
import { hashPassword } from './password';
import { normalizeCidr, normalizeIp, cidrContains } from './ip';
import { log } from './logger';
import { syncEdgeIpAllowlist } from './edge-sync';

export interface AdminAuditInput {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  status?: 'SUCCESS' | 'FAILURE';
  error?: string | null;
}

export function writeAdminAudit(
  req: Request,
  actor: { id: string; username: string },
  input: AdminAuditInput
): Promise<void> {
  return writeAudit({
    actorId: actor.id,
    actorLabel: actor.username,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    before: input.before,
    after: input.after,
    ip: getRequestIp(req),
    userAgent: getUserAgent(req),
    status: input.status ?? 'SUCCESS',
    error: input.error ?? null
  });
}

export interface PublicUser {
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

export function publicUser(
  user: User & {
    _count?: { chats?: number; sessions?: number; aiProviders?: number };
    messages?: number;
  }
): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    role: user.role,
    status: user.status,
    displayName: user.displayName,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    chats: user._count?.chats ?? 0,
    messages: user.messages ?? 0,
    activeSessions: user._count?.sessions ?? 0,
    providers: user._count?.aiProviders ?? 0
  };
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function parsePage(url: URL, defaultSize = 20): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Math.min(100_000, Number(url.searchParams.get('page') || 1) || 1));
  const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') || defaultSize) || defaultSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export async function listUsers(url: URL): Promise<PageResult<PublicUser>> {
  const { page, pageSize, skip } = parsePage(url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 64);
  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } }
        ]
      }
    : {};
  const now = new Date();
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
      skip,
      take: pageSize,
      include: {
        _count: {
          select: {
            chats: true,
            aiProviders: true,
            sessions: { where: { revokedAt: null, expiresAt: { gt: now } } }
          }
        }
      }
    }),
    prisma.user.count({ where })
  ]);
  const counts = rows.length
    ? await prisma.message.groupBy({
        by: ['chatId'],
        where: { chat: { userId: { in: rows.map((r) => r.id) } } },
        _count: { _all: true }
      })
    : [];
  const chatToUser = new Map(
    (
      await prisma.chat.findMany({
        where: { userId: { in: rows.map((r) => r.id) } },
        select: { id: true, userId: true }
      })
    ).map((c) => [c.id, c.userId])
  );
  const messageCounts = new Map<string, number>();
  for (const row of counts) {
    const userId = chatToUser.get(row.chatId);
    if (!userId) continue;
    messageCounts.set(userId, (messageCounts.get(userId) ?? 0) + row._count._all);
  }
  return {
    items: rows.map((row) => publicUser({ ...row, messages: messageCounts.get(row.id) ?? 0 })),
    total,
    page,
    pageSize
  };
}

function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(18);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `Tmp-${out}-9`;
}

export async function createManagedUser(input: {
  username: string;
  email: string;
  displayName?: string | null;
}): Promise<{ user: PublicUser; temporaryPassword: string }> {
  const username = input.username.trim();
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
    select: { username: true, email: true }
  });
  if (existing) {
    throw new ApiError(
      409,
      'USER_EXISTS',
      existing.username === username ? '用户名已被占用' : '邮箱已被注册'
    );
  }
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await prisma.user.create({
    data: {
      username,
      email,
      emailVerified: new Date(),
      passwordHash,
      role: 'USER',
      status: 'ACTIVE',
      displayName: input.displayName?.trim().slice(0, 64) || username
    }
  });
  log.info('admin.user_created', { userId: user.id });
  return { user: publicUser(user), temporaryPassword };
}

export async function setUserStatus(
  userId: string,
  status: 'ACTIVE' | 'DISABLED',
  actorId: string
): Promise<PublicUser> {
  if (userId === actorId) throw new ApiError(400, 'SELF_TARGET', '不能修改自己的账号状态');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
  if (user.role === 'OWNER') throw new ApiError(403, 'OWNER_PROTECTED', '不能修改超级管理员的状态');
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.user.update({ where: { id: userId }, data: { status } });
    if (status === 'DISABLED') {
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }
    return row;
  });
  return publicUser(updated);
}

export async function resetManagedUserPassword(
  userId: string
): Promise<{ temporaryPassword: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
  if (user.role === 'OWNER') {
    throw new ApiError(403, 'OWNER_PROTECTED', '不能在此重置超级管理员密码，请使用账号设置或服务器恢复命令');
  }
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() }
    })
  ]);
  return { temporaryPassword };
}

export async function setUserEmail(userId: string, email: string): Promise<PublicUser> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
  const clash = await prisma.user.findFirst({
    where: { email: normalized, id: { not: userId } },
    select: { id: true }
  });
  if (clash) throw new ApiError(409, 'EMAIL_EXISTS', '邮箱已被其他账号使用');
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { email: normalized, emailVerified: new Date() }
  });
  return publicUser(updated);
}

export async function deleteManagedUser(userId: string, actorId: string): Promise<void> {
  if (userId === actorId) throw new ApiError(400, 'SELF_TARGET', '不能删除自己的账号');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
  if (user.role === 'OWNER') throw new ApiError(403, 'OWNER_PROTECTED', '不能删除超级管理员账号');

  await prisma.$transaction([
    prisma.attachment.deleteMany({ where: { userId } }),
    prisma.message.deleteMany({ where: { chat: { userId } } }),
    prisma.chat.deleteMany({ where: { userId } }),
    prisma.aiProvider.deleteMany({ where: { ownerType: 'USER', userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.emailToken.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } })
  ]);
  const env = loadEnv();
  const root = path.resolve(env.UPLOAD_DIR);
  const dir = path.resolve(root, userId);
  if (dir.startsWith(`${root}${path.sep}`)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface PublicIpRule {
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

export function publicIpRule(
  rule: {
    id: string;
    cidr: string;
    label: string | null;
    enabled: boolean;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lastMatchedAt: Date | null;
    createdById: string | null;
  }
): PublicIpRule {
  const expired = Boolean(rule.expiresAt && rule.expiresAt.getTime() <= Date.now());
  return {
    id: rule.id,
    cidr: rule.cidr,
    label: rule.label ?? rule.cidr,
    enabled: rule.enabled,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    status: !rule.enabled ? 'disabled' : expired ? 'expired' : 'active',
    createdBy: rule.createdById,
    lastMatchedAt: rule.lastMatchedAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString()
  };
}

function normalizeCidrSafe(input: string): string {
  try {
    return normalizeCidr(input).cidr;
  } catch {
    throw new ApiError(400, 'INVALID_CIDR', 'IP/CIDR 格式无效');
  }
}

export async function listIpRules(): Promise<PublicIpRule[]> {
  const rows = await prisma.ipRule.findMany({ orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }] });
  return rows.map(publicIpRule);
}

interface RuleLike {
  id?: string;
  cidr: string;
  enabled: boolean;
  expiresAt: Date | null;
}

async function activeRulesExcept(id?: string): Promise<RuleLike[]> {
  const now = new Date();
  return prisma.ipRule.findMany({
    where: {
      enabled: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(id ? { id: { not: id } } : {})
    },
    select: { id: true, cidr: true, enabled: true, expiresAt: true }
  });
}

/**
 * Refuses any whitelist mutation that would leave the acting owner's current IP outside
 * every active rule. This is the last line of defence against locking everyone out.
 */
export async function assertActingIpRemainsAllowed(
  actingIp: string | null,
  nextRules: RuleLike[]
): Promise<void> {
  if (!actingIp) throw new ApiError(400, 'UNKNOWN_CLIENT_IP', '无法确定当前客户端 IP，已阻止修改白名单');
  let normalized;
  try {
    normalized = normalizeIp(actingIp);
  } catch {
    throw new ApiError(400, 'UNKNOWN_CLIENT_IP', '当前客户端 IP 无效，已阻止修改白名单');
  }
  const beforeRules = await activeRulesExcept();
  const wasAllowed = beforeRules.some((rule) => cidrContains(rule.cidr, normalized.ip));
  if (!wasAllowed) return;
  const stillAllowed = nextRules.some((rule) => rule.enabled && cidrContains(rule.cidr, normalized.ip));
  if (!stillAllowed) {
    throw new ApiError(
      409,
      'LOCKOUT_RISK',
      '此操作会让当前 IP 失去白名单访问权限，已被阻止。请先添加新的允许规则，或先切换到新网络。'
    );
  }
}

export async function ensureRuleUsableForActingIp(actingIp: string | null): Promise<void> {
  const rules = await activeRulesExcept();
  if (!actingIp) throw new ApiError(400, 'UNKNOWN_CLIENT_IP', '无法确定当前客户端 IP');
  let normalized;
  try {
    normalized = normalizeIp(actingIp);
  } catch {
    throw new ApiError(400, 'UNKNOWN_CLIENT_IP', '当前客户端 IP 无效');
  }
  if (!rules.some((rule) => cidrContains(rule.cidr, normalized.ip))) {
    throw new ApiError(403, 'IP_NOT_ALLOWED', '当前 IP 不在生效的白名单中，无法执行该操作');
  }
}

export async function createIpRule(input: {
  cidr: string;
  label: string;
  enabled?: boolean;
  expiresAt?: Date | null;
  createdById: string;
  actingIp: string | null;
}): Promise<PublicIpRule> {
  const normalized = normalizeCidrSafe(input.cidr);
  const existing = await prisma.ipRule.findUnique({ where: { cidr: normalized } });
  if (existing) throw new ApiError(409, 'RULE_EXISTS', '该 IP/CIDR 规则已存在');
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'INVALID_EXPIRY', '临时访问的到期时间必须晚于当前时间');
  }
  const before = await activeRulesExcept();
  const next: RuleLike[] = [
    ...before,
    { cidr: normalized, enabled: input.enabled !== false, expiresAt: input.expiresAt ?? null }
  ];
  if (input.enabled !== false) await assertActingIpRemainsAllowed(input.actingIp, next);
  const created = await prisma.ipRule.create({
    data: {
      cidr: normalized,
      label: input.label.trim().slice(0, 64) || normalized,
      enabled: input.enabled !== false,
      expiresAt: input.expiresAt ?? null,
      createdById: input.createdById
    }
  });
  void syncEdgeIpAllowlist('create');
  return publicIpRule(created);
}

export async function updateIpRule(input: {
  id: string;
  cidr?: string;
  label?: string;
  enabled?: boolean;
  expiresAt?: Date | null;
  actingIp: string | null;
}): Promise<PublicIpRule> {
  const rule = await prisma.ipRule.findUnique({ where: { id: input.id } });
  if (!rule) throw new ApiError(404, 'RULE_NOT_FOUND', '规则不存在');
  const cidr = input.cidr !== undefined ? normalizeCidrSafe(input.cidr) : rule.cidr;
  if (cidr !== rule.cidr) {
    const clash = await prisma.ipRule.findUnique({ where: { cidr } });
    if (clash) throw new ApiError(409, 'RULE_EXISTS', '该 IP/CIDR 规则已存在');
  }
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : rule.expiresAt;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'INVALID_EXPIRY', '临时访问的到期时间必须晚于当前时间');
  }
  const enabled = input.enabled !== undefined ? input.enabled : rule.enabled;
  const others = await activeRulesExcept(rule.id);
  const next: RuleLike[] = [...others, { id: rule.id, cidr, enabled, expiresAt }];
  // Always verify: disabling, expiring or moving a rule can each remove the acting IP's access.
  await assertActingIpRemainsAllowed(input.actingIp, next);
  const updated = await prisma.ipRule.update({
    where: { id: rule.id },
    data: {
      cidr,
      label: input.label !== undefined ? input.label.trim().slice(0, 64) || cidr : rule.label,
      enabled,
      expiresAt
    }
  });
  void syncEdgeIpAllowlist('update');
  return publicIpRule(updated);
}

export async function deleteIpRule(input: {
  id: string;
  actingIp: string | null;
}): Promise<void> {
  const rule = await prisma.ipRule.findUnique({ where: { id: input.id } });
  if (!rule) throw new ApiError(404, 'RULE_NOT_FOUND', '规则不存在');
  const others = await activeRulesExcept(rule.id);
  await assertActingIpRemainsAllowed(input.actingIp, others);
  await prisma.ipRule.delete({ where: { id: rule.id } });
  void syncEdgeIpAllowlist('delete');
}

export interface OverviewData {
  users: { total: number; active: number; disabled: number; owners: number };
  chats: { total: number; messages: number };
  storage: { attachments: number; bytes: number; uploadsBytes: number };
  models: { global: number; user: number; enabled: number };
  access: { rules: number; activeRules: number; sessions: number; logins24h: number; denied24h: number };
  service: ServiceStatus;
}

export interface ServiceStatus {
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  loadAverage: number[];
  memory: { rssBytes: number; heapUsedBytes: number; systemFreeBytes: number; systemTotalBytes: number };
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
  database: { ok: boolean; latencyMs: number; sizeBytes: number | null; version: string | null };
  appUrl: string;
  nodeEnv: string;
  startedAt: string;
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  const env = loadEnv();
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  const dbStarted = Date.now();
  let dbOk = false;
  let sizeBytes: number | null = null;
  let version: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    const size = await prisma.$queryRaw<Array<{ size: bigint }>>`SELECT pg_database_size(current_database()) AS size`;
    sizeBytes = size[0] ? Number(size[0].size) : null;
    const ver = await prisma.$queryRaw<Array<{ server_version: string }>>`SHOW server_version`;
    version = ver[0]?.server_version ?? null;
  } catch (err) {
    log.warn('admin.db_status_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const dbLatency = Date.now() - dbStarted;
  let disk: ServiceStatus['disk'] = null;
  try {
    const stat = await fs.statfs(path.resolve(env.UPLOAD_DIR));
    disk = {
      path: path.resolve(env.UPLOAD_DIR),
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize)
    };
  } catch {
    try {
      const stat = await fs.statfs('/');
      disk = { path: '/', freeBytes: Number(stat.bavail) * Number(stat.bsize), totalBytes: Number(stat.blocks) * Number(stat.bsize) };
    } catch {
      disk = null;
    }
  }
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      systemFreeBytes: os.freemem(),
      systemTotalBytes: os.totalmem()
    },
    disk,
    database: { ok: dbOk, latencyMs: dbLatency, sizeBytes, version },
    appUrl: env.APP_URL,
    nodeEnv: process.env.NODE_ENV || 'development',
    startedAt: startedAt.toISOString()
  };
}

/** 每批并发的 stat 数量：串行往返太慢，一次性全开又会把事件循环压满。 */
const STAT_BATCH_SIZE = 32;

async function directorySize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < entries.length; i += STAT_BATCH_SIZE) {
    const sizes = await Promise.all(
      entries.slice(i, i + STAT_BATCH_SIZE).map(async (entry) => {
        if (!entry.isFile() && !entry.isDirectory()) return 0;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return directorySize(full);
        try {
          return (await fs.stat(full)).size;
        } catch {
          return 0;
        }
      })
    );
    for (const size of sizes) total += size;
  }
  return total;
}

export async function getOverview(): Promise<OverviewData> {
  const env = loadEnv();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();
  const [
    totalUsers,
    activeUsers,
    ownerCount,
    chats,
    messages,
    attachments,
    storageAgg,
    globalProviders,
    userProviders,
    enabledProviders,
    rules,
    activeRules,
    sessions,
    logins24h,
    denied24h,
    service,
    uploadsBytes
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { role: 'OWNER' } }),
    prisma.chat.count(),
    prisma.message.count(),
    prisma.attachment.count(),
    prisma.attachment.aggregate({ _sum: { size: true } }),
    prisma.aiProvider.count({ where: { ownerType: 'GLOBAL' } }),
    prisma.aiProvider.count({ where: { ownerType: 'USER' } }),
    prisma.aiProvider.count({ where: { enabled: true } }),
    prisma.ipRule.count(),
    prisma.ipRule.count({
      where: { enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
    }),
    prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
    prisma.loginLog.count({ where: { createdAt: { gt: dayAgo }, success: true } }),
    prisma.ipAccessLog.count({ where: { createdAt: { gt: dayAgo }, allowed: false } }),
    getServiceStatus(),
    directorySize(path.resolve(env.UPLOAD_DIR))
  ]);
  return {
    users: {
      total: totalUsers,
      active: activeUsers,
      disabled: totalUsers - activeUsers,
      owners: ownerCount
    },
    chats: { total: chats, messages },
    storage: {
      attachments,
      bytes: Number(storageAgg._sum.size ?? 0),
      uploadsBytes
    },
    models: { global: globalProviders, user: userProviders, enabled: enabledProviders },
    access: {
      rules,
      activeRules,
      sessions,
      logins24h,
      denied24h
    },
    service
  };
}

export interface LogFilters {
  page: number;
  pageSize: number;
  skip: number;
  from?: Date;
  to?: Date;
  success?: boolean;
  ip?: string;
  username?: string;
  action?: string;
  allowed?: boolean;
}

export function parseLogFilters(url: URL): LogFilters {
  const { page, pageSize, skip } = parsePage(url, 30);
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  const successRaw = url.searchParams.get('success');
  const allowedRaw = url.searchParams.get('allowed');
  return {
    page,
    pageSize,
    skip,
    from: from && !Number.isNaN(from.getTime()) ? from : undefined,
    to: to && !Number.isNaN(to.getTime()) ? to : undefined,
    success: successRaw === 'true' ? true : successRaw === 'false' ? false : undefined,
    allowed: allowedRaw === 'true' ? true : allowedRaw === 'false' ? false : undefined,
    ip: url.searchParams.get('ip')?.slice(0, 64) || undefined,
    username: url.searchParams.get('username')?.slice(0, 64) || undefined,
    action: url.searchParams.get('action')?.slice(0, 64) || undefined
  };
}

export async function listLoginLogs(filters: LogFilters) {
  const where: Prisma.LoginLogWhereInput = {
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
    ...(filters.success !== undefined ? { success: filters.success } : {}),
    ...(filters.ip ? { ip: { contains: filters.ip } } : {}),
    ...(filters.username ? { username: { contains: filters.username, mode: 'insensitive' } } : {})
  };
  const [items, total] = await Promise.all([
    prisma.loginLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filters.skip,
      take: filters.pageSize
    }),
    prisma.loginLog.count({ where })
  ]);
  return {
    items: items.map((row) => ({
      id: row.id,
      username: row.identifier,
      userId: row.userId,
      ip: row.ip,
      userAgent: row.userAgent,
      success: row.success,
      reason: row.reason,
      createdAt: row.createdAt.toISOString()
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize
  };
}

export async function listAuditLogs(filters: LogFilters) {
  const where: Prisma.AuditLogWhereInput = {
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
    ...(filters.action ? { action: { contains: filters.action } } : {}),
    ...(filters.ip ? { ip: { contains: filters.ip } } : {})
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filters.skip,
      take: filters.pageSize
    }),
    prisma.auditLog.count({ where })
  ]);
  return {
    items: items.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      before: row.before,
      after: row.after,
      ip: row.ip,
      userAgent: row.userAgent,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt.toISOString()
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize
  };
}

export async function listIpAccessLogs(filters: LogFilters) {
  const where: Prisma.IpAccessLogWhereInput = {
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
    ...(filters.allowed !== undefined ? { allowed: filters.allowed } : {}),
    ...(filters.ip ? { ip: { contains: filters.ip } } : {})
  };
  const [items, total] = await Promise.all([
    prisma.ipAccessLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filters.skip,
      take: filters.pageSize
    }),
    prisma.ipAccessLog.count({ where })
  ]);
  return {
    items: items.map((row) => ({
      id: row.id,
      ip: row.ip,
      method: row.method,
      path: row.path,
      allowed: row.allowed,
      reason: row.reason,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString()
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize
  };
}

export async function storageBreakdown() {
  const [perUser, totals] = await Promise.all([
    prisma.attachment.groupBy({
      by: ['userId'],
      _count: { _all: true },
      _sum: { size: true }
    }),
    prisma.attachment.aggregate({ _count: { _all: true }, _sum: { size: true } })
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: perUser.map((row) => row.userId) } },
    select: { id: true, username: true, displayName: true }
  });
  const nameMap = new Map(users.map((u) => [u.id, u.displayName || u.username]));
  return {
    total: {
      count: totals._count._all,
      bytes: Number(totals._sum.size ?? 0)
    },
    byUser: perUser
      .map((row) => ({
        userId: row.userId,
        username: nameMap.get(row.userId) ?? row.userId,
        count: row._count._all,
        bytes: Number(row._sum.size ?? 0)
      }))
      .sort((a, b) => b.bytes - a.bytes)
  };
}

export async function cleanupOrphanAttachments(actorId: string): Promise<{ removed: number; bytes: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // 只取清理需要的三列，并且一次查完：原来的第二条 findMany 不带 select，
  // 会把每个孤儿附件的分块密文整段读进内存，仅为拿一个 storageKey。
  const orphans = await prisma.attachment.findMany({
    where: { messageId: null, createdAt: { lt: cutoff } },
    select: { id: true, size: true, storageKey: true }
  });
  if (!orphans.length) return { removed: 0, bytes: 0 };
  const env = loadEnv();
  const root = path.resolve(env.UPLOAD_DIR);
  for (const orphan of orphans) {
    const resolved = path.resolve(root, orphan.storageKey);
    if (resolved.startsWith(`${root}${path.sep}`)) await fs.unlink(resolved).catch(() => undefined);
  }
  await prisma.attachment.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  log.info('admin.orphan_cleanup', { actorId, removed: orphans.length });
  return { removed: orphans.length, bytes: orphans.reduce((sum, o) => sum + o.size, 0) };
}
