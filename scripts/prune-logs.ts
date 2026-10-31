import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_RETENTION_DAYS = 30;

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main() {
  const rawDays = Number(argValue('--days'));
  const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : DEFAULT_RETENTION_DAYS;
  const dryRun = process.argv.includes('--dry-run');
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const byCreated = { createdAt: { lt: cutoff } };
  // 已过期的锁定行留着没有意义：没人会再来查询，也永远不会再拦截请求。
  const locks = { lockedUntil: { lt: cutoff, not: null } };

  const summary: Array<[string, number]> = [];
  if (dryRun) {
    summary.push(['IpAccessLog', await prisma.ipAccessLog.count({ where: byCreated })]);
    summary.push(['LoginLog', await prisma.loginLog.count({ where: byCreated })]);
    summary.push(['AuditLog', await prisma.auditLog.count({ where: byCreated })]);
    summary.push(['LoginLock', await prisma.loginLock.count({ where: locks })]);
  } else {
    summary.push(['IpAccessLog', (await prisma.ipAccessLog.deleteMany({ where: byCreated })).count]);
    summary.push(['LoginLog', (await prisma.loginLog.deleteMany({ where: byCreated })).count]);
    summary.push(['AuditLog', (await prisma.auditLog.deleteMany({ where: byCreated })).count]);
    summary.push(['LoginLock', (await prisma.loginLock.deleteMany({ where: locks })).count]);
  }

  console.log(`日志保留 ${days} 天，处理 ${cutoff.toISOString()} 之前的记录${dryRun ? '（试运行，未删除）' : ''}`);
  for (const [label, count] of summary) console.log(`  ${label}: ${count}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
