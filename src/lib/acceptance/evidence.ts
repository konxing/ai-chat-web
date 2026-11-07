import { prisma } from '../prisma';
import { listMemories, type MemoryDto } from '../cognitive/memories';
import { isAcceptanceUsername } from './virtual-users';

/**
 * 验收总计划书第 4 章的受控数据检查。
 *
 * 门开在用户名前缀上：只有 `acc_<runId>_<序号>` 形状的账号能被检查，
 * 真实用户连 listMemories 都不会被调用。正文解密复用服务层的 listMemories
 * （AAD 与 userId 隔离断言都在那一层），本模块不自己碰密文。
 *
 * 派生表只出 count：验收要判断的是「这条管线动没动」，不是读它的内容。
 */

/** 只数行数、不解密的派生表。 */
const COUNTED_TABLES = [
  'memoryRevision',
  'memoryRelation',
  'memoryCandidate',
  'cognitiveTask',
  'decisionRecord',
  'decisionOutcome',
  'reflectionRecord',
  'reflectionCitation',
  'memoryAccessTurn',
  'userProfileEntry'
] as const;

export interface AcceptanceEvidence {
  userId: string;
  username: string;
  /** 全量历史（含被取代的旧行），正文已解密。 */
  memories: MemoryDto[];
  /** 派生表 → 行数。 */
  counts: Record<string, number>;
}

export async function inspectVirtualUser(username: string): Promise<AcceptanceEvidence> {
  if (!isAcceptanceUsername(username)) {
    throw new Error(`受控检查只面向虚拟用户，拒绝: ${username}`);
  }
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true }
  });
  if (!user) throw new Error(`虚拟用户不存在: ${username}`);

  const memories = await listMemories(user.id, { includeSuperseded: true });
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const delegate = (prisma as unknown as Record<string, { count: (args: unknown) => Promise<number> }>)[
      table
    ];
    counts[table] = await delegate.count({ where: { userId: user.id } });
  }
  return { userId: user.id, username, memories, counts };
}
