const { spawnSync } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pending = '.env.windows-setup.local';
let step = '检查输入';
function progress(stage, message) {
  step = message;
  console.log(`STEP:${stage}:${message}`);
}

function invalidInput(message) {
  step = message;
  throw new Error();
}

async function setup() {
  if (fs.existsSync('.env')) invalidInput('此项目已经有配置，请返回管理窗口启动。');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { username, email, password, storageDirectory = '', reuseDatabase } = input;
  if (typeof username !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fa5-]{3,32}$/.test(username))
    invalidInput('管理员用户名须为 3–32 位字母、数字、下划线、连字符或中文。');
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    invalidInput('请填写有效的管理员邮箱，例如 admin@example.com。');
  if (typeof password !== 'string' || password.length < 10 || password.length > 128 || /[\r\n]/.test(password))
    invalidInput('管理员密码须为 10–128 个字符，不能包含换行。');
  if (typeof storageDirectory !== 'string' || (storageDirectory && (
    !/^[a-z]:[/\\]/i.test(storageDirectory) || /[<>:"|?*\u0000-\u001f]/u.test(storageDirectory.slice(2))
  ))) {
    invalidInput('附件与备份目录请输入本机磁盘的完整路径，例如 D:\\AIWebChat，或留空。');
  }

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12) || major === 23) {
    invalidInput('请使用 Node.js 22.12 或更新的长期支持版。');
  }
  if (!fs.existsSync('node_modules/typescript/bin/tsc') ||
      !fs.existsSync('node_modules/tailwindcss/package.json') ||
      !fs.existsSync('node_modules/dotenv/package.json') ||
      !fs.existsSync('node_modules/prisma/build/index.js') ||
      !fs.existsSync('node_modules/next/dist/bin/next') ||
      !fs.existsSync('node_modules/tsx/dist/cli.mjs')) {
    invalidInput('缺少构建依赖。请在项目目录运行 npm.cmd ci --include=dev，再重试。');
  }

  const { parse, populate } = require('dotenv');
  const config = fs.existsSync(pending) ? parse(fs.readFileSync(pending)) : null;
  if (reuseDatabase === true && !config?.DATABASE_URL) {
    invalidInput('没有可沿用的数据库配置，请填写连接资料后重试。');
  }
  const database = reuseDatabase === true ? config.DATABASE_URL : input.database;
  if (typeof database !== 'string' || !/^postgres(?:ql)?:\/\//.test(database) || /[\s"']/u.test(database))
    invalidInput('数据库连接地址须以 postgresql:// 开头，不含空格或引号。');
  let address;
  try {
    address = new URL(database);
    if (!address.hostname || !address.username || address.pathname.length <= 1) throw new Error();
    decodeURIComponent(address.username);
    decodeURIComponent(address.password);
    decodeURIComponent(address.pathname);
  } catch {
    invalidInput('请检查数据库地址，需填写主机、用户名和数据库名，特殊字符需做 URL 编码。');
  }
  if (address.hash) invalidInput('数据库地址含有 #，如果它属于数据库密码，请写成 %23。');

  require('tsx/cjs');
  const { passwordPolicyError, verifyPassword } = require('../../src/lib/password.ts');
  const policy = passwordPolicyError(password, { username, email });
  if (policy) invalidInput(policy);

  if (config && config.DATABASE_URL !== database) {
    invalidInput('首次配置已开始。请使用上次填写的数据库地址；若要换库，请备份并移走旧的 .env.windows-setup.local 后再试。');
  }
  if (config && (!config.APP_SECRET || !config.MASTER_KEY || !config.MASTER_KEY_ID)) {
    invalidInput('待完成的配置缺少加密密钥。请保留文件并检查上次初始化结果。');
  }
  const appSecret = config?.APP_SECRET ?? randomBytes(32).toString('hex');
  // The same pending configuration must be presented to resume a completed bootstrap.
  const setupId = createHmac('sha256', appSecret).update('AI WebChat Windows bootstrap').digest('hex').slice(0, 32);

  progress(1, '检查环境和数据库');
  populate(process.env, { DATABASE_URL: database }, { override: true });
  run('node_modules/prisma/build/index.js', ['generate']);

  function run(file, args, input) {
    const result = spawnSync(process.execPath, [file, ...args], {
      input, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024
    });
    if (!result.error && result.status === 0) return;
    const secrets = [
      database, address.password, decodeURIComponent(address.password),
      password, process.env.APP_SECRET, process.env.MASTER_KEY
    ].filter(Boolean).sort((a, b) => b.length - a.length);
    let output = [result.stdout, result.stderr, result.error?.code].filter(Boolean).join('\n');
    for (const secret of secrets) output = output.replaceAll(secret, '[已隐藏]');
    output = output.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[数据库地址已隐藏]');
    const log = path.join('dist', 'windows', 'setup-error.log');
    const failure = result.error?.code === 'ETIMEDOUT' ? '超过 10 分钟' : `退出状态 ${result.status ?? result.error?.code ?? '未知'}`;
    step += `（${failure}）`;
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, `${step}\n${output}`, { mode: 0o600 });
      step += `\n请查看项目目录中的 ${log}。`;
    } catch {
      step += '\n无法写入诊断日志，请检查项目目录权限。';
    }
    throw new Error();
  }

  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: database });
  let owner;
  let matchingReceipt = false;
  try {
    await db.$connect();
    try {
      owner = await db.user.findFirst({ where: { role: 'OWNER' } });
    } catch (error) {
      if (error.code !== 'P2021') throw error;
    }
    if (owner && config) {
      matchingReceipt = !!await db.auditLog.findFirst({
        where: { actorId: owner.id, action: 'system.bootstrap', targetId: setupId },
        select: { id: true }
      });
    }
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
  if (owner && !matchingReceipt) {
    invalidInput('数据库已有管理员，请使用其原配置，或改用新的空数据库。');
  }
  if (owner && (owner.status !== 'ACTIVE' || owner.username !== username || owner.email !== email.toLowerCase() ||
      !await verifyPassword(owner.passwordHash, password))) {
    invalidInput('请使用上次初始化时填写的管理员用户名、邮箱和密码。');
  }
  const storage = storageDirectory ? path.win32.normalize(storageDirectory).replaceAll('\\', '/') : '';
  const uploadDir = storage ? path.posix.join(storage, 'uploads') : config?.UPLOAD_DIR;
  const backupDir = storage ? path.posix.join(storage, 'backups') : config?.BACKUP_DIR;
  if (storage) {
    if (config && (config.UPLOAD_DIR !== uploadDir || config.BACKUP_DIR !== backupDir)) {
      invalidInput('初始化已开始。请填写上次选择的存储目录，或留空沿用原设置。');
    }
  }
  step = '附件或备份目录无法写入，请检查选择的磁盘和文件夹权限。';
  for (const dir of [uploadDir, backupDir]) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.setup-' + randomBytes(8).toString('hex'));
      fs.writeFileSync(probe, '', { flag: 'wx' });
      fs.unlinkSync(probe);
    }
  }
  if (!config) {
    const fields = [
      'DATABASE_URL=' + JSON.stringify(database),
      'APP_URL=http://127.0.0.1:3000', 'HOST=127.0.0.1', 'PORT=3000',
      'COOKIE_SECURE=false', 'TRUST_PROXY=false', 'ALLOW_INSECURE_COOKIES=true',
      'APP_SECRET=' + appSecret,
      'MASTER_KEY=' + randomBytes(32).toString('base64'),
      'MASTER_KEY_ID=v1'
    ];
    if (storage) {
      fields.push(
        'UPLOAD_DIR=' + JSON.stringify(uploadDir),
        'BACKUP_DIR=' + JSON.stringify(backupDir)
      );
    }
    step = '准备初始化配置';
    fs.writeFileSync(pending, fields.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  populate(process.env, config ?? parse(fs.readFileSync(pending)), { override: true });

  progress(2, '应用数据库迁移');
  run('node_modules/prisma/build/index.js', ['migrate', 'deploy']);
  progress(3, '构建网页');
  run('node_modules/next/dist/bin/next', ['build', '--webpack']);
  progress(4, owner ? '恢复管理员初始化' : '创建管理员');
  run('node_modules/tsx/dist/cli.mjs', ['scripts/bootstrap.ts', '--username', username, '--email', email,
    '--password-stdin', '--allow-ip', '127.0.0.1', '--site-name', 'AI Chat', '--setup-id', setupId], password);
  progress(5, '保存项目配置');
  fs.copyFileSync(pending, '.env', fs.constants.COPYFILE_EXCL);
  try { fs.unlinkSync(pending); } catch { /* .env has already been saved. */ }
}

setup().catch(() => {
  console.error(step);
  process.exitCode = 1;
});
