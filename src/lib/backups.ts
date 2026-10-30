import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from './env';
import { ApiError } from './http';

const FILE_PATTERN = /^family-chat-\d{8}-\d{6}\.facbackup$/;

export interface BackupMeta {
  file: string;
  createdAt: string | null;
  bytes: number;
  sha256: string | null;
  databaseBytes?: number;
  uploadsBytes?: number;
  uploadsSourceBytes?: number;
}

export function backupDir(): string {
  return path.resolve(loadEnv().BACKUP_DIR);
}

export function assertBackupName(name: string): string {
  if (!FILE_PATTERN.test(name)) throw new ApiError(400, 'INVALID_BACKUP_NAME', '备份文件名无效');
  return name;
}

export async function listBackups(): Promise<BackupMeta[]> {
  const dir = backupDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: BackupMeta[] = [];
  for (const name of entries) {
    if (!FILE_PATTERN.test(name)) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      let meta: Partial<BackupMeta> = {};
      try {
        meta = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf8')) as Partial<BackupMeta>;
      } catch {
        /* sidecar is optional */
      }
      out.push({
        file: name,
        createdAt: meta.createdAt ?? stat.mtime.toISOString(),
        bytes: stat.size,
        sha256: meta.sha256 ?? null,
        databaseBytes: meta.databaseBytes,
        uploadsBytes: meta.uploadsBytes,
        uploadsSourceBytes: meta.uploadsSourceBytes
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')).reverse();
}

let running = false;

export async function createBackup(): Promise<BackupMeta> {
  if (running) throw new ApiError(409, 'BACKUP_RUNNING', '已有备份任务正在进行');
  running = true;
  try {
    const env = loadEnv();
    if (!env.BACKUP_PASSPHRASE || env.BACKUP_PASSPHRASE.length < 12) {
      throw new ApiError(400, 'BACKUP_NOT_CONFIGURED', '未配置 BACKUP_PASSPHRASE（至少 12 个字符）');
    }
    const script = path.resolve('scripts/backup.mjs');
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--json'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ApiError(504, 'BACKUP_TIMEOUT', '备份超时'));
      }, 15 * 60 * 1000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new ApiError(500, 'BACKUP_FAILED', `无法启动备份：${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new ApiError(500, 'BACKUP_FAILED', (stderr || '备份失败').slice(0, 500)));
      });
    });
    const line = result.stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) throw new ApiError(500, 'BACKUP_FAILED', '备份脚本没有返回结果');
    const meta = JSON.parse(line) as BackupMeta;
    return meta;
  } finally {
    running = false;
  }
}

export async function backupFilePath(name: string): Promise<string> {
  assertBackupName(name);
  const dir = backupDir();
  const full = path.resolve(dir, name);
  if (!full.startsWith(`${dir}${path.sep}`)) throw new ApiError(400, 'INVALID_BACKUP_NAME', '备份文件名无效');
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new ApiError(404, 'BACKUP_NOT_FOUND', '备份不存在');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(404, 'BACKUP_NOT_FOUND', '备份不存在');
  }
  return full;
}
