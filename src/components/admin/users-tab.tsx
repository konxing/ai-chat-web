'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  Users
} from 'lucide-react';
import { apiFetch, errorMessage, formatDateTime, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import {
  Alert,
  EmptyState,
  LoadingBlock,
  Modal,
  Spinner,
  useConfirm,
  useReauth,
  useToast
} from '@/components/ui';
import type { AdminUser, Paged } from '@/lib/admin-types';

export function UsersTab() {
  const { requestPassword } = useReauth();
  const { confirm } = useConfirm();
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<AdminUser> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [emailTarget, setEmailTarget] = useState<AdminUser | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (applied) params.set('q', applied);
      setData(await apiFetch<Paged<AdminUser>>(`/api/admin/users?${params.toString()}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setApplied(query.trim());
    }, 320);
    return () => clearTimeout(timer);
  }, [query]);

  async function toggleStatus(user: AdminUser) {
    const next = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const ok = await confirm({
      title: next === 'DISABLED' ? `停用「${user.username}」？` : `重新启用「${user.username}」？`,
      description:
        next === 'DISABLED'
          ? '该用户的所有登录会话会立即失效，无法再登录或使用 API。'
          : '启用后该用户可以重新登录。',
      confirmText: next === 'DISABLED' ? '停用账号' : '启用账号',
      tone: next === 'DISABLED' ? 'danger' : 'primary'
    });
    if (!ok) return;
    const password = await requestPassword('修改用户状态需要验证管理员身份。');
    if (!password) return;
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        json: { action: 'setStatus', status: next, confirmPassword: password }
      });
      push(next === 'DISABLED' ? '账号已停用' : '账号已启用');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function resetPassword(user: AdminUser) {
    const ok = await confirm({
      title: `重置「${user.username}」的密码？`,
      description: '系统会生成一个一次性临时密码，并立即注销该用户所有设备上的登录。临时密码只显示一次。',
      confirmText: '重置密码',
      tone: 'danger'
    });
    if (!ok) return;
    const password = await requestPassword('重置用户密码需要验证管理员身份。');
    if (!password) return;
    try {
      const result = await apiFetch<{ temporaryPassword: string }>(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        json: { action: 'resetPassword', confirmPassword: password }
      });
      setTempPassword({ username: user.username, password: result.temporaryPassword });
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function remove(user: AdminUser) {
    const ok = await confirm({
      title: `永久删除「${user.username}」？`,
      description: '该用户的全部会话、消息、附件与个人模型配置都会删除，且不可恢复。建议先创建备份。',
      confirmText: '永久删除',
      tone: 'danger'
    });
    if (!ok) return;
    const password = await requestPassword('删除用户需要验证管理员身份。');
    if (!password) return;
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE',
        json: { confirmPassword: password }
      });
      push('用户已删除');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-white">用户管理</h1>
          <p className="mt-1 text-[12.5px] text-white/40">创建家庭成员、重置密码、停用或删除账号。超级管理员账号受保护。</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 新建用户
          </button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
        <input
          className="field !pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索用户名、邮箱或昵称"
        />
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {loading && !data ? (
        <LoadingBlock label="加载用户" />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={applied ? '没有匹配的用户' : '还没有其他用户'}
          description={applied ? '尝试其他关键词。' : '可以创建一个账号，把临时密码线下告诉家人。'}
          action={
            !applied ? (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                新建用户
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table min-w-[860px]">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>状态</th>
                  <th>数据</th>
                  <th>最近登录</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[12px] font-semibold text-white/70">
                          {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-white/85">
                            {user.displayName || user.username}
                            {user.role === 'OWNER' ? (
                              <span className="badge badge-amber">
                                <ShieldCheck className="h-3 w-3" /> 管理员
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[11.5px] text-white/35">
                            @{user.username} · {user.email}
                            {!user.emailVerified ? '（未验证）' : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {user.status === 'ACTIVE' ? (
                        <span className="badge badge-green">启用</span>
                      ) : (
                        <span className="badge badge-red">停用</span>
                      )}
                    </td>
                    <td>
                      <div className="text-[11.5px] text-white/45">
                        {user.chats} 会话 · {user.messages} 消息
                      </div>
                      <div className="text-[11.5px] text-white/30">
                        {user.providers} 模型 · {user.activeSessions} 会话在线
                      </div>
                    </td>
                    <td>
                      <div className="text-[11.5px] text-white/45">{user.lastLoginAt ? timeAgo(user.lastLoginAt) : '从未登录'}</div>
                      <div className="text-[11px] text-white/25">加入于 {formatDateTime(user.createdAt)}</div>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="btn-icon"
                          title="修改邮箱"
                          onClick={() => setEmailTarget(user)}
                        >
                          <Mail className="h-4 w-4" />
                        </button>
                        {user.role !== 'OWNER' ? (
                          <>
                            <button type="button" className="btn-icon" title="重置密码" onClick={() => resetPassword(user)}>
                              <KeyRound className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="btn-icon"
                              title={user.status === 'ACTIVE' ? '停用账号' : '启用账号'}
                              onClick={() => toggleStatus(user)}
                            >
                              {user.status === 'ACTIVE' ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                            </button>
                            <button
                              type="button"
                              className="btn-icon text-red-300/70 hover:text-red-200"
                              title="删除用户"
                              onClick={() => remove(user)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onChange={setPage}
            busy={loading}
          />
        </div>
      )}

      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(username, password) => {
          setCreating(false);
          setTempPassword({ username, password });
          void load();
        }}
      />

      <EmailModal
        user={emailTarget}
        onClose={() => setEmailTarget(null)}
        onSaved={() => {
          setEmailTarget(null);
          void load();
        }}
      />

      <Modal
        open={Boolean(tempPassword)}
        onClose={() => setTempPassword(null)}
        title="临时密码（仅显示一次）"
        description="请通过安全渠道线下告知对方，并要求登录后立即修改密码。"
        footer={
          <button type="button" className="btn-primary" onClick={() => setTempPassword(null)}>
            我已记录
          </button>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
            <div>
              <div className="text-[11px] text-white/35">用户名</div>
              <div className="text-[14px] text-white/85">{tempPassword?.username}</div>
            </div>
            <button
              type="button"
              className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
              onClick={() => {
                if (!tempPassword) return;
                void navigator.clipboard?.writeText(tempPassword.password).then(
                  () => push('临时密码已复制'),
                  () => push('复制失败，请手动记录', 'error')
                );
              }}
            >
              <Copy className="h-4 w-4" /> 复制
            </button>
          </div>
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 font-mono text-[15px] tracking-wide text-emerald-100">
            {tempPassword?.password}
          </div>
          <p className="text-[11.5px] leading-relaxed text-white/35">
            该密码不会再次显示，系统仅保存 Argon2id 哈希。重置密码会使该用户所有已登录设备立即退出。
          </p>
        </div>
      </Modal>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  busy
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  busy?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] px-4 py-3 text-[12px] text-white/40">
      <span>
        共 {total} 条 · 第 {page} / {pages} 页
      </span>
      <div className="flex gap-1.5">
        <button type="button" className="btn-ghost !px-2.5 !py-1 !text-[12px]" disabled={page <= 1 || busy} onClick={() => onChange(page - 1)}>
          上一页
        </button>
        <button
          type="button"
          className="btn-ghost !px-2.5 !py-1 !text-[12px]"
          disabled={page >= pages || busy}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function CreateUserModal({
  open,
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (username: string, tempPassword: string) => void;
}) {
  const { requestPassword } = useReauth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setUsername('');
      setEmail('');
      setDisplayName('');
      setError('');
    }
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const password = await requestPassword('创建新用户需要验证管理员身份。');
    if (!password) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ user: AdminUser; temporaryPassword: string }>('/api/admin/users', {
        method: 'POST',
        json: {
          username: username.trim(),
          email: email.trim(),
          displayName: displayName.trim() || null,
          confirmPassword: password
        }
      });
      onCreated(result.user.username, result.temporaryPassword);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建家庭成员账号"
      description="系统会生成一次性临时密码，并通过安全渠道告知对方。"
      width="520px"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">用户名</label>
          <input
            className="field"
            required
            minLength={3}
            maxLength={32}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="例如 anning"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="label">邮箱</label>
          <input
            className="field"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="label">昵称（可选）</label>
          <input
            className="field"
            maxLength={64}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例如 安宁"
          />
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner /> : <Plus className="h-4 w-4" />} 创建
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmailModal({
  user,
  onClose,
  onSaved
}: {
  user: AdminUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { requestPassword } = useReauth();
  const { push } = useToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setEmail(user.email);
      setError('');
    }
  }, [user]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user) return;
    setError('');
    const password = await requestPassword('修改用户邮箱需要验证管理员身份。');
    if (!password) return;
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        json: { action: 'setEmail', email: email.trim(), confirmPassword: password }
      });
      push('邮箱已更新并标记为已验证');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={Boolean(user)} onClose={onClose} title="修改用户邮箱" description={`账号：${user?.username ?? ''}`} width="480px">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">新邮箱</label>
          <input className="field" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <p className="text-[11.5px] leading-relaxed text-white/35">
          管理员修改邮箱后，该邮箱会直接标记为已验证。请确认邮箱确实属于该用户。
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className={cn('btn-primary')} disabled={busy}>
            {busy ? <Spinner /> : null} 保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
