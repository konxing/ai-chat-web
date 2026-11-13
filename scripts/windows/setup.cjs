const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { parse, populate } = require('dotenv');
const { PrismaClient } = require('@prisma/client');

const pending = '.env.windows-setup.local';
let step = '检查输入';
async function setup() {
  if (fs.existsSync('.env')) throw new Error('已有配置');
  const { database, username, email, password } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (typeof database !== 'string' || !/^postgres(?:ql)?:\/\//.test(database) || /[\s"']/u.test(database))
    throw new Error('数据库地址格式无效');
  if (typeof username !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fa5-]{3,32}$/.test(username) ||
      typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ||
      typeof password !== 'string' || password.length < 12 || password.length > 200 || /[\r\n]/.test(password))
    throw new Error('管理员资料格式无效');

  populate(process.env, { DATABASE_URL: database }, { override: true });

  function run(file, args, input) {
    const result = spawnSync(process.execPath, [file, ...args], {
      input, encoding: 'utf8', windowsHide: true, timeout: 600000
    });
    if (result.error || result.status !== 0) throw new Error();
  }

  step = '检查数据库连接及现有账号';
  const db = new PrismaClient({ datasourceUrl: database });
  let owner;
  try {
    await db.$connect();
    const table = await db.$queryRaw`SELECT to_regclass('"User"') IS NOT NULL AS present`;
    if (table[0].present) owner = await db.user.findFirst({ where: { role: 'OWNER' } });
  } finally {
    await db.$disconnect();
  }
  if (owner) {
    step = '数据库已有管理员，请使用其原配置，或改用新的空数据库';
    throw new Error();
  }
  if (!fs.existsSync(pending)) {
    const config = [
      'DATABASE_URL=' + JSON.stringify(database),
      'APP_URL=http://127.0.0.1:3000', 'HOST=127.0.0.1', 'PORT=3000',
      'COOKIE_SECURE=false', 'TRUST_PROXY=false', 'ALLOW_INSECURE_COOKIES=true',
      'APP_SECRET=' + randomBytes(32).toString('hex'),
      'MASTER_KEY=' + randomBytes(32).toString('base64'),
      'MASTER_KEY_ID=v1'
    ].join('\n');
    fs.writeFileSync(pending, config + '\n', { flag: 'wx', mode: 0o600 });
  }
  const config = parse(fs.readFileSync(pending));
  if (config.DATABASE_URL !== database) {
    step = '首次配置已开始，请使用上一次填写的数据库地址';
    throw new Error();
  }
  populate(process.env, config, { override: true });

  step = '生成数据库客户端';
  run('node_modules/prisma/build/index.js', ['generate']);
  step = '应用数据库迁移';
  run('node_modules/prisma/build/index.js', ['migrate', 'deploy']);
  step = '构建网页';
  run('node_modules/next/dist/bin/next', ['build']);
  step = '创建管理员，请检查密码是否符合要求';
  run('node_modules/tsx/dist/cli.mjs', ['scripts/bootstrap.ts', '--username', username, '--email', email,
    '--password-stdin', '--allow-ip', '127.0.0.1', '--site-name', 'AI Chat'], password);
  step = '保存项目配置';
  fs.copyFileSync(pending, '.env', fs.constants.COPYFILE_EXCL);
  fs.unlinkSync(pending);
}

setup().catch(() => {
  console.error(step);
  process.exitCode = 1;
});
