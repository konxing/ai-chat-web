'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, Download, HardDrive, RefreshCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { apiFetch, csrfHeader, downloadBlob, errorMessage, formatBytes, formatDateTime } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, Spinner, useConfirm, useReauth, useToast } from '@/components/ui';
import type { BackupMeta, StorageBreakdown } from '@/lib/admin-types';

export function StorageTab() {
  const { requestPassword } = useReauth();
  const { confirm } = useConfirm();
  const { push } = useToast();
  const [storage, setStorage] = useState<StorageBreakdown | null>(null);
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [downloading, setDownloading] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [storageData, backupData] = await Promise.all([
        apiFetch<StorageBreakdown>('/api/admin/storage'),
        apiFetch<{ backups: BackupMeta[] }>('/api/admin/backups')
      ]);
      setStorage(storageData);
      setBackups(backupData.backups);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function cleanup() {
    const ok = await confirm({
      title: '清理孤立附件？',
      description: '删除超过 24 小时、未关联任何消息的附件记录与文件。已发送消息中的附件不受影响。',
      confirmText: '开始清理',
      tone: 'danger'
    });
    if (!ok) return;
    const password = await requestPassword('清理存储需要验证管理员身份。');
    if (!password) return;
    setCleaning(true);
    try {
      const result = await apiFetch<{ removed: number; bytes: number }>('/api/admin/storage', {
        method: 'POST',
        json: { action: 'cleanupOrphans', confirmPassword: password }
      });
      push(`已清理 ${result.removed} 个孤立附件，释放 ${formatBytes(result.bytes)}`);
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setCleaning(false);
    }
  }

  async function createBackup() {
    const password = await requestPassword('创建加密备份需要验证管理员身份。备份包含数据库与全部附件。');
    if (!password) return;
    setCreating(true);
    try {
      const result = await apiFetch<{ backup: BackupMeta }>('/api/admin/backups', {
        method: 'POST',
        json: { confirmPassword: password }
      });
      push(`备份已创建：${result.backup.file}`);
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function download(backup: BackupMeta) {
    const password = await requestPassword(`下载备份「${backup.file}」需要验证管理员身份。备份使用主密钥派生的密钥加密。`);
    if (!password) return;
    setDownloading(backup.file);
    try {
      const response = await fetch('/api/admin/backups/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ file: backup.file, confirmPassword: password }),
        credentials: 'same-origin'
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message || `下载失败（HTTP ${response.status}）`);
      }
      downloadBlob(await response.blob(), backup.file);
      push('备份下载已开始');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setDownloading('');
    }
  }

  if (loading && !storage) return <LoadingBlock label="加载存储信息" />;
  if (error && !storage) return <Alert tone="error">{error}</Alert>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-white">存储与备份</h1>
          <p className="mt-1 text-[12.5px] text-white/40">
            备份文件使用独立密钥加密，包含数据库与上传附件；可在服务器上使用恢复脚本还原。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => void createBackup()} disabled={creating}>
            {creating ? <Spinner /> : <Archive className="h-4 w-4" />} 创建加密备份
          </button>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
              <HardDrive className="h-4 w-4 text-amber-300" /> 附件占用
            </h2>
            <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => void cleanup()} disabled={cleaning}>
              {cleaning ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />} 清理孤立附件
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] text-white/35">附件总数</div>
              <div className="mt-1 text-[20px] font-semibold text-white">{storage?.total.count ?? 0}</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] text-white/35">占用空间</div>
              <div className="mt-1 text-[20px] font-semibold text-white">{formatBytes(storage?.total.bytes ?? 0)}</div>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {storage?.byUser.length ? (
              storage.byUser.map((row) => (
                <div key={row.userId} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.02] px-3 py-2 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate text-white/70">{row.username}</span>
                  <span className="text-white/35">{row.count} 个</span>
                  <span className="w-24 text-right font-mono text-white/55">{formatBytes(row.bytes)}</span>
                </div>
              ))
            ) : (
              <p className="text-[12px] text-white/35">还没有上传任何附件。</p>
            )}
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
            <ShieldCheck className="h-4 w-4 text-emerald-300" /> 备份策略
          </h2>
          <ul className="mt-3 space-y-2.5 text-[12px] leading-relaxed text-white/45">
            <li>· 备份文件格式为 .facbackup，AES-256-GCM + scrypt 派生密钥。</li>
            <li>· 包含加密数据库转储、附件归档与 SHA-256 校验清单。</li>
            <li>· 恢复脚本会先自动创建恢复前备份，校验和失败会中止。</li>
            <li>· 建议将备份下载后离线保存，并定期在测试环境演练恢复。</li>
          </ul>
          <div className="mt-4 rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-100/70">
            备份密钥来自服务器主密钥环（KEYRING），请与备份文件分开保管。丢失密钥将无法恢复备份。
          </div>
        </section>
      </div>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
            <Archive className="h-4 w-4 text-sky-300" /> 备份文件
          </h2>
          <span className="text-[11.5px] text-white/30">共 {backups.length} 个</span>
        </div>
        {backups.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<Archive className="h-5 w-5" />}
              title="还没有备份"
              description="创建第一个加密备份，下载后离线保存。"
              action={
                <button type="button" className="btn-primary" onClick={() => void createBackup()} disabled={creating}>
                  {creating ? <Spinner /> : <Sparkles className="h-4 w-4" />} 创建备份
                </button>
              }
            />
          </div>
        ) : (
          <div className="mt-3 divide-y divide-white/[0.05]">
            {backups.map((backup) => (
              <div key={backup.file} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <Archive className="h-4 w-4 shrink-0 text-white/30" />
                <div className="min-w-0 flex-1">
                  <div className="break-all font-mono text-[12.5px] text-white/80">{backup.file}</div>
                  <div className="mt-0.5 text-[11px] text-white/35">
                    {formatDateTime(backup.createdAt)} · {formatBytes(backup.bytes)}
                    {backup.databaseBytes ? ` · 数据库 ${formatBytes(backup.databaseBytes)}` : ''}
                    {backup.uploadsBytes ? ` · 附件 ${formatBytes(backup.uploadsBytes)}` : ''}
                  </div>
                  {backup.sha256 ? (
                    <div className="mt-0.5 truncate font-mono text-[10.5px] text-white/20">SHA-256 {backup.sha256}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                  disabled={downloading === backup.file}
                  onClick={() => void download(backup)}
                >
                  {downloading === backup.file ? <Spinner /> : <Download className="h-3.5 w-3.5" />} 下载
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="text-[14px] font-semibold text-white">恢复与灾难恢复</h2>
        <div className="mt-3 space-y-2 text-[12px] leading-relaxed text-white/45">
          <p>在服务器项目目录执行恢复脚本（会要求输入确认，并自动创建恢复前备份）：</p>
          <pre className="overflow-auto rounded-xl border border-white/[0.06] bg-black/30 p-3 font-mono text-[11.5px] text-white/60">
{`node scripts/restore.mjs /path/to/family-chat-YYYYMMDD-HHMMSS.facbackup --yes
# 仅恢复数据库：
node scripts/restore.mjs <backup> --db-only --yes
# 仅恢复附件：
node scripts/restore.mjs <backup> --uploads-only --yes`}
          </pre>
          <p>
            恢复过程中会校验文件头、解密、验证清单 SHA-256，并用 pg_restore 在单个事务中重建数据库。附件目录会先重命名为
            <code className="mx-1 rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-white/60">.pre-restore-时间戳</code>
            后再写入，失败时可人工回滚。
          </p>
          <p className="text-amber-200/60">
            若失去全部管理员访问：在服务器本地通过恢复命令重建 owner 账号，或在数据库主机上直接使用 bootstrap 脚本重置，详见部署文档「紧急恢复」。
          </p>
        </div>
      </section>
    </div>
  );
}
