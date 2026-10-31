#!/usr/bin/env node
/**
 * Restore an encrypted `.facbackup` created by scripts/backup.mjs.
 *
 * Usage:
 *   node scripts/restore.mjs <file.facbackup> --yes [--skip-pre-backup] [--db-only|--uploads-only]
 *
 * The application should be stopped before a full restore. A safety backup of the
 * current state is taken automatically unless --skip-pre-backup is given.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('FACBACKUP1');
const HEADER = 10 + 16 + 12 + 16;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function loadDotEnv() {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    /* optional */
  }
}


function pgConnection(raw) {
  // DATABASE_URL may contain Prisma-only query parameters that libpq rejects.
  // 密码一律不进 argv：本机任何用户都能从进程列表里读到命令行。
  try {
    const url = new URL(raw);
    for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size']) {
      url.searchParams.delete(key);
    }
    let password = '';
    try {
      password = url.password ? decodeURIComponent(url.password) : '';
    } catch {
      password = url.password;
    }
    url.password = '';
    return { conninfo: url.toString(), password };
  } catch {
    return { conninfo: raw, password: process.env.PGPASSWORD || '' };
  }
}

function pgEnv(password) {
  return password ? { ...process.env, PGPASSWORD: password } : process.env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 800)}`));
    });
  });
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const yes = args.includes('--yes');
  const skipPre = args.includes('--skip-pre-backup');
  const dbOnly = args.includes('--db-only');
  const uploadsOnly = args.includes('--uploads-only');
  if (!file) {
    console.error('Usage: node scripts/restore.mjs <file.facbackup> --yes [--skip-pre-backup] [--db-only|--uploads-only]');
    process.exit(1);
  }
  if (dbOnly && uploadsOnly) throw new Error('--db-only and --uploads-only are mutually exclusive');

  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  const databaseUrl = process.env.DATABASE_URL || '';
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  if (!passphrase) throw new Error('BACKUP_PASSPHRASE is required');
  if (!databaseUrl && !uploadsOnly) throw new Error('DATABASE_URL is required');

  const source = path.resolve(file);
  const handle = await fsp.open(source, 'r');
  const header = Buffer.alloc(HEADER);
  try {
    const { bytesRead } = await handle.read(header, 0, HEADER, 0);
    if (bytesRead !== HEADER) throw new Error('文件过小，不是有效的备份');
  } finally {
    await handle.close();
  }
  const magic = header.subarray(0, 10);
  if (!magic.equals(MAGIC)) throw new Error('备份文件标识无效');
  const salt = header.subarray(10, 26);
  const iv = header.subarray(26, 38);
  const tag = header.subarray(38, 54);

  if (!yes) {
    console.error('这将覆盖当前数据库和上传文件。确认后请重新执行并加上 --yes。');
    process.exit(2);
  }

  const work = await fsp.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'fac-restore-'));
  const payload = path.join(work, 'payload.tar.gz');
  try {
    console.error('restore: verifying and decrypting');
    const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    await pipeline(
      fs.createReadStream(source, { start: HEADER }),
      decipher,
      fs.createWriteStream(payload, { mode: 0o600 })
    );

    await run('tar', ['-xzf', payload, '-C', work, '--no-same-owner']);
    const manifest = JSON.parse(await fsp.readFile(path.join(work, 'manifest.json'), 'utf8'));
    if (manifest.format !== 1) throw new Error('不支持的备份格式版本');
    for (const key of ['database', 'uploads']) {
      const entry = manifest[key];
      if (!entry?.file) throw new Error(`备份清单缺少 ${key}`);
      const actual = await sha256File(path.join(work, entry.file));
      if (actual !== entry.sha256) throw new Error(`${entry.file} 完整性校验失败`);
    }
    console.error(`restore: backup created at ${manifest.createdAt}`);

    if (!skipPre) {
      console.error('restore: taking a safety backup of the current state');
      await run(process.execPath, [path.resolve('scripts/backup.mjs'), '--json']);
    }

    if (!dbOnly) {
      console.error('restore: restoring uploads');
      const stage = path.join(work, 'stage');
      await fsp.mkdir(stage, { recursive: true });
      await run('tar', ['-xzf', path.join(work, 'uploads.tar.gz'), '-C', stage, '--no-same-owner']);
      const extracted = path.join(stage, manifest.uploads.dirName);
      const target = uploadDir;
      let moved = null;
      if (fs.existsSync(target)) {
        moved = `${target}.pre-restore-${stamp()}`;
        await fsp.rename(target, moved);
      }
      try {
        if (fs.existsSync(extracted)) await fsp.rename(extracted, target);
        else await fsp.mkdir(target, { recursive: true });
      } catch (err) {
        if (moved) await fsp.rename(moved, target).catch(() => undefined);
        throw err;
      }
      if (moved) console.error(`restore: previous uploads kept at ${moved}`);
    }

    if (!uploadsOnly) {
      console.error('restore: restoring database (this replaces all current tables)');
      const pg = pgConnection(databaseUrl);
      await run(
        'pg_restore',
        [
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
          '--single-transaction',
          '--dbname',
          pg.conninfo,
          path.join(work, 'db.dump')
        ],
        { env: pgEnv(pg.password) }
      );
    }
    console.error('restore: done. Restart the application and sign in again.');
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`restore failed: ${err.message}`);
  process.exit(1);
});
