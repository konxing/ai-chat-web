/* Emergency recovery, run from the server console/SSH. Does not require the web app.
 * Usage:
 *   npx tsx scripts/emergency.ts --allow-ip 203.0.113.10 --label "recovery"
 *   printf '%s\n' "$NEW_PASSWORD" | npx tsx scripts/emergency.ts --reset-owner-password --username owner
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { normalizeCidr } from '../src/lib/ip';
import { hashPassword, passwordPolicyError } from '../src/lib/password';

const prisma = new PrismaClient();

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const allowIp = argValue('--allow-ip');
  const label = argValue('--label') || 'Emergency recovery';
  const reset = process.argv.includes('--reset-owner-password');
  if (!allowIp && !reset) {
    console.error('Nothing to do. Use --allow-ip or --reset-owner-password.');
    process.exitCode = 1;
    return;
  }

  if (allowIp) {
    const { cidr } = normalizeCidr(allowIp);
    const owner = await prisma.user.findFirst({ where: { role: 'OWNER' } });
    await prisma.ipRule.upsert({
      where: { cidr },
      create: { cidr, label: label.slice(0, 128), enabled: true, createdById: owner?.id ?? null },
      update: { enabled: true, label: label.slice(0, 128), expiresAt: null }
    });
    await prisma.auditLog.create({
      data: {
        actorId: owner?.id ?? null,
        actorLabel: 'server-cli emergency',
        action: 'ip.emergency_allow',
        targetType: 'ip_rule',
        targetId: cidr,
        ip: 'server-cli',
        status: 'SUCCESS',
        after: { cidr, label }
      }
    });
    console.log(`✓ Emergency allow rule added: ${cidr}`);
    console.log('Run: npm run sync:nginx -- --reload   (and update cloud firewall / nftables if applicable)');
  }

  if (reset) {
    const username = argValue('--username');
    if (!username) throw new Error('--reset-owner-password requires --username');
    const password = await readStdin();
    if (!password) throw new Error('Password must be provided on stdin');
    const owner = await prisma.user.findUnique({ where: { username } });
    if (!owner || owner.role !== 'OWNER') throw new Error('User is not the owner');
    const policy = passwordPolicyError(password, { username: owner.username, email: owner.email });
    if (policy) throw new Error(policy);
    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: owner.id }, data: { passwordHash, status: 'ACTIVE' } }),
      prisma.session.updateMany({ where: { userId: owner.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.auditLog.create({
        data: {
          actorId: owner.id,
          actorLabel: 'server-cli emergency',
          action: 'owner.password_reset_emergency',
          targetType: 'user',
          targetId: owner.id,
          ip: 'server-cli',
          status: 'SUCCESS',
          after: { sessionsRevoked: true }
        }
      })
    ]);
    console.log(`✓ Owner ${owner.username} password reset; all sessions revoked.`);
  }
}

main()
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
