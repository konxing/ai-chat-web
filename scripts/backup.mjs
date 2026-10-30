#!/usr/bin/env node
/**
 * Encrypted backup utility.
 *
 * Produces one `.facbackup` file containing:
 *   header: magic "FACBACKUP1" | salt(16) | iv(12) | authTag(16) | ciphertext
 *   ciphertext: gzip tar of manifest.json + db.dump + uploads.tar.gz
 *
 * Usage: node scripts/backup.mjs [--out DIR] [--json]
 * Requires: pg_dump, tar, BACKUP_PASSPHRASE, DATABASE_URL, UPLOAD_DIR.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('FACBACKUP1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function loadDotEnv() {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    /* .env is optional when variables come from the environment */
  }
}


function pgConnectionUrl(raw) {
  // DATABASE_URL may contain Prisma-only query parameters that libpq rejects.
  try {
    const url = new URL(raw);
    for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size']) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function log(message, extra) {
  if (extra) console.error(message, JSON.stringify(extra));
  else console.error(message);
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

async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const dir = path.resolve(outIdx !== -1 ? args[outIdx + 1] : process.env.BACKUP_DIR || './backups');
  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  const databaseUrl = process.env.DATABASE_URL || '';
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');

  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (passphrase.length < 12) throw new Error('BACKUP_PASSPHRASE must be at least 12 characters');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const stamp = timestamp();
  const work = await fsp.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'fac-backup-'));
  const payload = path.join(work, 'payload.tar.gz');
  const outFile = path.join(dir, `family-chat-${stamp}.facbackup`);
  try {
    log('backup: dumping database');
    const dbFile = path.join(work, 'db.dump');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${dbFile}`, '--dbname', pgConnectionUrl(databaseUrl)]);

    log('backup: archiving uploads');
    const uploadsFile = path.join(work, 'uploads.tar.gz');
    const uploadsName = path.basename(uploadDir);
    await run('tar', ['-czf', uploadsFile, '-C', path.dirname(uploadDir), uploadsName]).catch(async (err) => {
      if (!fs.existsSync(uploadDir)) {
        await fsp.writeFile(uploadsFile, '');
        return;
      }
      throw err;
    });

    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      app: 'family-ai-chat',
      database: { file: 'db.dump', sha256: await sha256File(dbFile), bytes: (await fsp.stat(dbFile)).size },
      uploads: {
        file: 'uploads.tar.gz',
        dirName: uploadsName,
        sha256: await sha256File(uploadsFile),
        bytes: (await fsp.stat(uploadsFile)).size,
        sourceBytes: await dirSize(uploadDir)
      },
      node: process.version
    };
    await fsp.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

    await run('tar', ['-czf', payload, '-C', work, 'manifest.json', 'db.dump', 'uploads.tar.gz']);

    log('backup: encrypting');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(MAGIC);
    // Encrypt to a temporary file first, then assemble header + tag + ciphertext atomically.
    const cipherFile = path.join(work, 'payload.enc');
    await pipeline(fs.createReadStream(payload), cipher, fs.createWriteStream(cipherFile, { mode: 0o600 }));
    const tag = cipher.getAuthTag();
    await new Promise((resolve, reject) => {
      const finalOut = fs.createWriteStream(outFile, { mode: 0o600 });
      finalOut.on('error', reject);
      finalOut.write(Buffer.concat([MAGIC, salt, iv, tag]));
      pipeline(fs.createReadStream(cipherFile), finalOut).then(resolve).catch(reject);
    });
    cipher.destroy();

    const digest = await sha256File(outFile);
    const size = (await fsp.stat(outFile)).size;
    const meta = {
      file: path.basename(outFile),
      createdAt: manifest.createdAt,
      bytes: size,
      sha256: digest,
      databaseBytes: manifest.database.bytes,
      uploadsBytes: manifest.uploads.bytes,
      uploadsSourceBytes: manifest.uploads.sourceBytes
    };
    await fsp.writeFile(`${outFile}.json`, JSON.stringify(meta, null, 2), { mode: 0o600 });
    if (json) process.stdout.write(`${JSON.stringify(meta)}\n`);
    else log(`backup: written ${outFile} (${size} bytes)`);
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`backup failed: ${err.message}`);
  process.exit(1);
});
