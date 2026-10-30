/* Secure first-run bootstrap: creates the unique owner, sets its password from stdin,
 * seeds system settings and writes the initial IP allowlist rules.
 * No default password is ever embedded in source code. */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword, passwordPolicyError } from '../src/lib/password';
import { normalizeCidr } from '../src/lib/ip';
import { seedDefaultSettings, updateSystemSettings } from '../src/lib/config';

const prisma = new PrismaClient();

interface Args {
  username?: string;
  email?: string;
  passwordStdin: boolean;
  generatePassword: boolean;
  resetPassword: boolean;
  allowIps: string[];
  noLoopback: boolean;
  skipIps: boolean;
  siteName?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    passwordStdin: false,
    generatePassword: false,
    resetPassword: false,
    allowIps: [],
    noLoopback: false,
    skipIps: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--username') args.username = argv[++i];
    else if (arg === '--email') args.email = argv[++i];
    else if (arg === '--password-stdin') args.passwordStdin = true;
    else if (arg === '--generate-password') args.generatePassword = true;
    else if (arg === '--reset-password') args.resetPassword = true;
    else if (arg === '--allow-ip') args.allowIps.push(argv[++i] || '');
    else if (arg === '--no-loopback') args.noLoopback = true;
    else if (arg === '--skip-ip') args.skipIps = true;
    else if (arg === '--site-name') args.siteName = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    console.log('请输入管理员密码（输入不回显），然后按回车：');
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
      process.stdout.write('Password: ');
      let password = '';
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const ch of text) {
          if (ch === '\r' || ch === '\n') {
            process.stdout.write('\n');
            stdin.off('data', onData);
            stdin.setRawMode?.(false);
            rl.close();
            resolve(password);
            return;
          }
          if (ch === '\u0003') {
            process.stdout.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') {
            password = password.slice(0, -1);
          } else {
            password += ch;
          }
        }
      };
      try {
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on('data', onData);
      } catch (err) {
        rl.close();
        reject(err);
      }
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function generateStrongPassword(): string {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

function printHelp() {
  console.log(`Usage:
  npm run bootstrap -- --username owner --email owner@example.com --password-stdin \\
      --allow-ip 203.0.113.10 --site-name "澄境 · Family AI"

Options:
  --username <name>         Owner username (3-32 chars)
  --email <email>           Owner email
  --password-stdin          Read password from stdin (REQUIRED in production)
  --generate-password       Generate a strong password and print it once
  --allow-ip <ip|cidr>      Add an initial allowlist rule (repeatable)
  --no-loopback             Do not add 127.0.0.1/32 and ::1/128
  --skip-ip                 Do not write any IP rules (site will deny everyone)
  --site-name <name>        Initial site name
  --reset-password          Reset the existing owner's password (requires username)
  --help

Examples:
  # First deployment
  printf '%s\\n' "$ADMIN_PASSWORD" | npm run bootstrap -- \\
    --username owner --email owner@example.com --password-stdin \\
    --allow-ip 198.51.100.23 --site-name "Our Family AI"

  # Owner password recovery from server console (revokes all sessions)
  printf '%s\\n' "$NEW_PASSWORD" | npm run bootstrap -- \\
    --reset-password --username owner --password-stdin
`);
}

function validateUsername(v: string): string {
  const value = v.trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{3,32}$/.test(value)) {
    throw new Error('用户名需为 3-32 位字母、数字、下划线、中文或连字符');
  }
  return value;
}

function validateEmail(v: string): string {
  const value = v.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    throw new Error('邮箱格式无效');
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const envPassword = args.generatePassword ? generateStrongPassword() : await readPasswordFromStdin();
  if (!envPassword) throw new Error('密码不能为空');
  const username = args.username ? validateUsername(args.username) : '';
  const email = args.email ? validateEmail(args.email) : '';

  const ownerCount = await prisma.user.count({ where: { role: 'OWNER' } });

  if (args.resetPassword) {
    if (!username) throw new Error('--reset-password 需要 --username');
    const owner = await prisma.user.findUnique({ where: { username } });
    if (!owner || owner.role !== 'OWNER') throw new Error('指定用户不是超级管理员');
    const policy = passwordPolicyError(envPassword, { username: owner.username, email: owner.email });
    if (policy) throw new Error(policy);
    const passwordHash = await hashPassword(envPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: owner.id },
        data: { passwordHash, status: 'ACTIVE', emailVerified: owner.emailVerified ?? new Date() }
      }),
      prisma.session.updateMany({
        where: { userId: owner.id, revokedAt: null },
        data: { revokedAt: new Date() }
      }),
      prisma.auditLog.create({
        data: {
          actorId: owner.id,
          actorLabel: `${owner.username} (server CLI)`,
          action: 'owner.password_reset_cli',
          targetType: 'user',
          targetId: owner.id,
          ip: 'server-cli',
          status: 'SUCCESS',
          after: { sessionsRevoked: true }
        }
      })
    ]);
    console.log(`✓ 已重置超级管理员 ${owner.username} 的密码，并撤销全部会话。`);
    if (args.generatePassword) console.log(`一次性新密码（请立即保存）：${envPassword}`);
    return;
  }

  if (ownerCount > 0) {
    throw new Error('超级管理员已存在。使用 --reset-password 进行密码恢复；不会创建第二个管理员。');
  }
  if (!username || !email) throw new Error('首次初始化必须提供 --username 和 --email');

  const policy = passwordPolicyError(envPassword, { username, email });
  if (policy) throw new Error(policy);

  const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
  if (existing) throw new Error('用户名或邮箱已被占用');

  const passwordHash = await hashPassword(envPassword);

  const rules = new Map<string, { cidr: string; label: string }>();
  if (!args.skipIps) {
    if (!args.noLoopback) {
      for (const [raw, label] of [
        ['127.0.0.1/32', 'Bootstrap loopback (server-local)'],
        ['::1/128', 'Bootstrap IPv6 loopback (server-local)']
      ] as const) {
        const { cidr } = normalizeCidr(raw);
        rules.set(cidr, { cidr, label });
      }
    }
    for (const raw of args.allowIps) {
      if (!raw) continue;
      const { cidr } = normalizeCidr(raw);
      rules.set(cidr, { cidr, label: 'Initial administrator access' });
    }
  }

  if (!rules.size && !args.skipIps) {
    console.warn('警告：没有配置任何 IP 白名单规则，网站将对所有访问者拒绝（包括你）。');
    console.warn('可从服务器控制台运行 emergency-allow-ip 脚本恢复访问。');
  }

  const owner = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        email,
        emailVerified: new Date(),
        passwordHash,
        role: 'OWNER',
        status: 'ACTIVE'
      }
    });
    for (const rule of rules.values()) {
      await tx.ipRule.upsert({
        where: { cidr: rule.cidr },
        create: {
          cidr: rule.cidr,
          label: rule.label,
          enabled: true,
          createdById: user.id
        },
        update: { enabled: true, label: rule.label, createdById: user.id }
      });
    }
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        actorLabel: `${user.username} (bootstrap CLI)`,
        action: 'system.bootstrap',
        targetType: 'system',
        ip: 'server-cli',
        status: 'SUCCESS',
        after: { username: user.username, email: user.email, ipRules: Array.from(rules.values()).map((r) => r.cidr) }
      }
    });
    return user;
  });

  await seedDefaultSettings(owner.id);
  await updateSystemSettings(
    {
      ...(args.siteName ? { siteName: args.siteName.slice(0, 80) } : {}),
      registrationOpen: false
    },
    owner.id
  );

  console.log('');
  console.log('✓ 超级管理员初始化完成');
  console.log(`  用户名：${owner.username}`);
  console.log(`  邮箱：${owner.email}`);
  console.log(`  角色：OWNER（唯一超级管理员）`);
  console.log(`  IP 规则：${rules.size ? Array.from(rules.values()).map((r) => r.cidr).join(', ') : '无（默认拒绝全部）'}`);
  if (args.generatePassword) console.log(`  一次性密码（请立即保存）：${envPassword}`);
  console.log('');
  console.log('下一步：');
  console.log('  1. npm run sync:nginx -- --reload   # 同步 Nginx 白名单');
  console.log('  2. npm run sync:firewall -- --apply # 同步 nftables（可选，谨慎执行）');
  console.log('  3. 启动应用并确认仅白名单 IP 可访问');
  console.log('');
}

main()
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
