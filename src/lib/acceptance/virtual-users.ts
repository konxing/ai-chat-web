import { randomBytes } from 'node:crypto';
import { prisma } from '../prisma';
import { hashPassword } from '../password';

/**
 * 验收总计划书第 3 章的虚拟用户工厂。
 *
 * 隔离靠三件事，缺一件都不行：
 * 一、用户名前缀 `acc_<runId>_<三位序号>` 是虚拟用户的唯一身份标记，清理只认它；
 * 二、runId 先过格式校验再进 startsWith——空串或过短的 runId 会把匹配面撑大；
 * 三、清理逐行复核角色，前缀撞上的 OWNER 行让整轮中止，而不是跳过那一行继续删。
 *
 * 密码明文只从 createVirtualUsers 的返回值出去一次（给验收驱动器登录用），
 * 库里只有 argon2 哈希；本模块不写日志，谁调用谁负责不明文落盘。
 */

export const ACCEPTANCE_USERNAME_PREFIX = 'acc_';
export const ACCEPTANCE_EMAIL_DOMAIN = 'acceptance.invalid';

const RUN_ID_PATTERN = /^[a-z0-9]{6,16}$/;

/** 逐表残留检查：cascade 漏掉哪张表，报告里就点哪张表的名。 */
const RESIDUE_TABLES = [
  'session',
  'chat',
  'aiProvider',
  'cognitivePreference',
  'memoryPolicy',
  'memoryPolicySignal',
  'memoryItem',
  'memoryRevision',
  'memoryRelation',
  'memoryExclusion',
  'memoryCandidate',
  'memoryEvidence',
  'cognitiveTask',
  'decisionRecord',
  'decisionOutcome',
  'reflectionRecord',
  'reflectionCitation',
  'memoryAccessTurn',
  'userProfileEntry'
] as const;

export interface VirtualUserEntry {
  userId: string;
  username: string;
  password: string;
}

export interface CleanupReport {
  runId: string;
  deletedUsers: number;
  /** 表名 → 残留行数；空对象表示清干净了。 */
  residue: Record<string, number>;
}

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`runId 必须是 6-16 位小写字母或数字，收到: ${JSON.stringify(runId)}`);
  }
}

export function acceptanceUsername(runId: string, index: number): string {
  return `${ACCEPTANCE_USERNAME_PREFIX}${runId}_${String(index).padStart(3, '0')}`;
}

const USERNAME_PATTERN = /^acc_[a-z0-9]{6,16}_\d{3}$/;

export function isAcceptanceUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export async function createVirtualUsers(input: {
  runId: string;
  count: number;
}): Promise<VirtualUserEntry[]> {
  assertValidRunId(input.runId);
  const created: VirtualUserEntry[] = [];
  for (let i = 1; i <= input.count; i += 1) {
    const username = acceptanceUsername(input.runId, i);
    const password = randomBytes(18).toString('base64url');
    const user = await prisma.user.create({
      data: {
        username,
        email: `${username}@${ACCEPTANCE_EMAIL_DOMAIN}`,
        emailVerified: new Date(),
        passwordHash: await hashPassword(password),
        role: 'USER',
        status: 'ACTIVE',
        displayName: username
      }
    });
    created.push({ userId: user.id, username, password });
  }
  return created;
}

export async function cleanupVirtualUsers(input: { runId: string }): Promise<CleanupReport> {
  assertValidRunId(input.runId);
  const targets = await prisma.user.findMany({
    where: { username: { startsWith: `${ACCEPTANCE_USERNAME_PREFIX}${input.runId}_` } },
    select: { id: true, username: true, role: true }
  });
  for (const target of targets) {
    if (target.role !== 'USER' || !isAcceptanceUsername(target.username)) {
      throw new Error(
        `清理中止：${target.username} 的角色是 ${target.role}，虚拟用户不该出现 OWNER 或畸形名`
      );
    }
  }
  for (const target of targets) {
    await prisma.user.delete({ where: { id: target.id } });
  }
  const ids = targets.map((target) => target.id);
  const residue: Record<string, number> = {};
  if (ids.length > 0) {
    for (const table of RESIDUE_TABLES) {
      const delegate = (prisma as unknown as Record<string, { count: (args: unknown) => Promise<number> }>)[
        table
      ];
      const count = await delegate.count({ where: { userId: { in: ids } } });
      if (count > 0) residue[table] = count;
    }
  }
  return { runId: input.runId, deletedUsers: targets.length, residue };
}
