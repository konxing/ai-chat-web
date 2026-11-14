const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { parse, populate } = require('dotenv');
const { PrismaClient } = require('@prisma/client');

const pending = '.env.windows-setup.local';
let step = '检查输入';
function invalidInput(message) {
  step = message;
  throw new Error();
}

async function setup() {
  if (fs.existsSync('.env')) throw new Error('已有配置');
  const { database, username, email, password } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (typeof database !== 'string' || !/^postgres(?:ql)?:\/\//.test(database) || /[\s"']/u.test(database))
    invalidInput('数据库连接地址须以 postgresql:// 开头，不含空格或引号。');
  if (typeof username !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fa5-]{3,32}$/.test(username))
    invalidInput('管理员用户名须为 3–32 位字母、数字、下划线或中文。');
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    invalidInput('请填写有效的管理员邮箱，例如 admin@example.com。');
  if (typeof password !== 'string' || password.length < 10 || password.length > 128 || /[\r\n]/.test(password))
    invalidInput('管理员密码须为 10–128 个字符，不能包含换行。');

  let address;
  try {
    address = new URL(database);
    if (!address.hostname || !address.username || address.pathname.length <= 1) throw new Error();
    decodeURIComponent(address.password);
  } catch {
    invalidInput('请检查数据库地址，需填写主机、用户名和数据库名，密码中的特殊字符需做 URL 编码。');
  }
  if (address.hash) invalidInput('数据库地址含有 #，如果它属于数据库密码，请写成 %23。');
  populate(process.env, { DATABASE_URL: database }, { override: true });
  step = '生成数据库客户端';
  run('node_modules/prisma/build/index.js', ['generate']);

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
  } catch (error) {
    const messages = {
      P1000: 'PostgreSQL 认证失败，请核对数据库用户名和密码。密码含特殊字符时需要做 URL 编码。',
      P1001: '无法连接 PostgreSQL，请确认 Windows 中的 PostgreSQL 服务已启动，并核对主机和端口。',
      P1002: '连接 PostgreSQL 超时，请检查数据库服务是否正常响应。',
      P1003: '数据库不存在。请先在 pgAdmin 创建空库，并让地址最后一段与库名一致。',
      P1010: '数据库账号没有访问权限，请核对数据库所有者或授权。',
      P1011: '数据库 TLS 连接失败，请检查连接地址中的 SSL 设置。',
      P1013: '数据库连接地址格式无效，请核对地址和密码编码。'
    };
    const code = error.errorCode ?? error.code;
    step = Object.hasOwn(messages, code) ? messages[code] : '数据库检查失败，请在 pgAdmin 中用相同账号连接目标数据库，检查数据库是否可访问。';
    if (typeof code === 'string' && /^P\d{4}$/.test(code)) step += '（' + code + '）';
    throw error;
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

  step = '应用数据库迁移';
  run('node_modules/prisma/build/index.js', ['migrate', 'deploy']);
  step = '构建网页';
  run('node_modules/next/dist/bin/next', ['build', '--webpack']);
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
