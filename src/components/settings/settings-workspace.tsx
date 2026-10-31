'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  BadgeCheck,
  Bot,
  Check,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Mail,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  UserRound,
  X
} from 'lucide-react';
import { apiFetch, codeSentMessage, errorMessage, formatDateTime, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { BrandMark } from '@/components/brand';
import {
  Alert,
  ConfirmProvider,
  EmptyState,
  LoadingBlock,
  Modal,
  Spinner,
  ToastProvider,
  useConfirm,
  useToast
} from '@/components/ui';
import type { ProviderDto } from '@/lib/chat-types';

interface AccountUser {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  role: 'OWNER' | 'USER';
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

const CAPS: Array<{ key: ProviderDto['capabilities'][number]; label: string }> = [
  { key: 'text', label: '文本' },
  { key: 'vision', label: '图像理解' },
  { key: 'files', label: '文件' },
  { key: 'audio', label: '语音' }
];

type Tab = 'profile' | 'security' | 'models' | 'about';

export function SettingsWorkspace({ initialUser }: { initialUser: AccountUser }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SettingsInner initialUser={initialUser} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function SettingsInner({ initialUser }: { initialUser: AccountUser }) {
  const { push } = useToast();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState<Tab>('profile');
  const [user, setUser] = useState<AccountUser>(initialUser);
  const [displayName, setDisplayName] = useState(initialUser.displayName ?? '');
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const [emailStage, setEmailStage] = useState<'idle' | 'code'>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailNotice, setEmailNotice] = useState('');

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [editing, setEditing] = useState<ProviderDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail: string } | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const data = await apiFetch<{ sessions: SessionInfo[] }>('/api/account/sessions');
      setSessions(data.sessions);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setSessionsLoading(false);
    }
  }, [push]);

  const loadProviders = useCallback(async () => {
    try {
      const data = await apiFetch<{ mine: ProviderDto[] }>('/api/account/providers');
      setProviders(data.mine);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setProvidersLoading(false);
    }
  }, [push]);

  useEffect(() => {
    void loadSessions();
    void loadProviders();
  }, [loadSessions, loadProviders]);

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setSavingName(true);
    try {
      const data = await apiFetch<{ user: AccountUser }>('/api/account', {
        method: 'PATCH',
        json: { displayName: displayName.trim() || null }
      });
      setUser(data.user);
      push('昵称已更新');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordError('');
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    setPasswordBusy(true);
    try {
      await apiFetch('/api/account/password', {
        method: 'POST',
        json: { currentPassword, newPassword }
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      push('密码已更新，其他设备已退出登录');
      void loadSessions();
    } catch (err) {
      setPasswordError(errorMessage(err));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function requestEmailCode(event: React.FormEvent) {
    event.preventDefault();
    setEmailError('');
    setEmailNotice('');
    setEmailBusy(true);
    try {
      const data = await apiFetch<{ channel?: string }>('/api/account/email/request', {
        method: 'POST',
        json: { newEmail: newEmail.trim(), password: emailPassword }
      });
      setEmailStage('code');
      setEmailNotice(codeSentMessage(data.channel, newEmail.trim()));
    } catch (err) {
      setEmailError(errorMessage(err));
    } finally {
      setEmailBusy(false);
    }
  }

  async function verifyEmail(event: React.FormEvent) {
    event.preventDefault();
    setEmailError('');
    setEmailBusy(true);
    try {
      const data = await apiFetch<{ user: AccountUser }>('/api/account/email/verify', {
        method: 'POST',
        json: { newEmail: newEmail.trim(), code: emailCode.trim() }
      });
      setUser(data.user);
      setEmailStage('idle');
      setNewEmail('');
      setEmailPassword('');
      setEmailCode('');
      setEmailNotice('');
      push('邮箱已更新');
    } catch (err) {
      setEmailError(errorMessage(err));
    } finally {
      setEmailBusy(false);
    }
  }

  async function revokeSession(id: string) {
    try {
      await apiFetch(`/api/account/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((item) => item.id !== id));
      push('该设备已退出登录');
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function revokeOthers() {
    try {
      const data = await apiFetch<{ revoked: number }>('/api/account/sessions', { method: 'POST' });
      await loadSessions();
      push(`已退出其他 ${data.revoked} 个会话`);
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function toggleProvider(provider: ProviderDto, patch: { enabled?: boolean; isDefault?: boolean }) {
    try {
      const data = await apiFetch<{ provider: ProviderDto }>('/api/account/providers', {
        method: 'PATCH',
        json: { id: provider.id, ...patch }
      });
      setProviders((prev) => prev.map((item) => (item.id === provider.id ? data.provider : item)));
      if (patch.isDefault) void loadProviders();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function deleteProvider(provider: ProviderDto) {
    const ok = await confirm({
      title: `删除模型「${provider.name}」？`,
      description: `该配置使用 ${provider.modelId}。删除后不可恢复，历史消息仍保留所用模型的记录。`,
      confirmText: '删除模型',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/account/providers?id=${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      setProviders((prev) => prev.filter((item) => item.id !== provider.id));
      push('模型配置已删除');
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function testProvider(provider: ProviderDto) {
    setTestingId(provider.id);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; detail: string }>('/api/account/providers/test', {
        method: 'POST',
        json: { id: provider.id }
      });
      setTestResult({ id: provider.id, ...result });
    } catch (err) {
      setTestResult({ id: provider.id, ok: false, detail: errorMessage(err) });
    } finally {
      setTestingId('');
    }
  }

  const defaultProvider = useMemo(() => providers.find((p) => p.isDefault), [providers]);

  return (
    <div className="relative min-h-[100dvh]">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(60%_50%_at_20%_0%,rgba(99,102,241,0.12),transparent_60%),radial-gradient(45%_40%_at_90%_10%,rgba(45,212,191,0.08),transparent_60%)]" />
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#07090f]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/chat" className="btn-icon" aria-label="返回对话">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-8 w-8" />
            <div>
              <div className="text-[15px] font-semibold text-white">设置</div>
              <div className="text-[11px] text-white/35">账户 · 安全 · 模型</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {user.role === 'OWNER' ? (
              <Link href="/admin" className="btn-ghost hidden sm:inline-flex">
                <Shield className="h-4 w-4" /> 管理后台
              </Link>
            ) : null}
            <Link href="/chat" className="btn-ghost">
              返回对话
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="flex gap-1.5 overflow-x-auto lg:flex-col">
          {(
            [
              ['profile', '个人资料', UserRound],
              ['security', '安全与登录', ShieldCheck],
              ['models', '我的模型', Bot],
              ['about', '安全说明', Lock]
            ] as Array<[Tab, string, typeof UserRound]>
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13px] transition',
                tab === key ? 'bg-white/[0.08] text-white' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/80'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-5">
          {tab === 'profile' ? (
            <>
              <section className="panel p-5 sm:p-6">
                <h2 className="text-[16px] font-semibold text-white">账户信息</h2>
                <p className="mt-1 text-[12.5px] text-white/40">用户名用于登录，昵称仅用于站内展示。</p>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="label">用户名</div>
                    <div className="field flex items-center text-white/70">{user.username}</div>
                  </div>
                  <div>
                    <div className="label">角色</div>
                    <div className="field flex items-center gap-2 text-white/70">
                      {user.role === 'OWNER' ? (
                        <>
                          <BadgeCheck className="h-4 w-4 text-amber-300" /> 超级管理员
                        </>
                      ) : (
                        '家庭成员'
                      )}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="label">邮箱</div>
                    <div className="field flex flex-wrap items-center gap-2 text-white/70">
                      <Mail className="h-4 w-4 text-white/35" />
                      {user.email}
                      {user.emailVerified ? (
                        <span className="badge badge-green">已验证</span>
                      ) : (
                        <span className="badge badge-amber">未验证</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="label">注册时间</div>
                    <div className="field text-white/55">{formatDateTime(user.createdAt)}</div>
                  </div>
                  <div>
                    <div className="label">最近登录</div>
                    <div className="field text-white/55">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</div>
                  </div>
                </div>
                <form onSubmit={saveName} className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <label className="label" htmlFor="displayName">
                      昵称
                    </label>
                    <input
                      id="displayName"
                      className="field"
                      maxLength={64}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="例如：安宁"
                    />
                  </div>
                  <button type="submit" className="btn-primary" disabled={savingName}>
                    {savingName ? <Spinner /> : <Check className="h-4 w-4" />} 保存昵称
                  </button>
                </form>
              </section>

              <section className="panel p-5 sm:p-6">
                <h2 className="text-[16px] font-semibold text-white">更换邮箱</h2>
                <p className="mt-1 text-[12.5px] text-white/40">
                  更换后需要输入发送到新邮箱的验证码。验证码 10 分钟内有效，仅可使用一次。
                </p>
                {emailNotice ? (
                  <div className="mt-4">
                    <Alert tone="success">{emailNotice}</Alert>
                  </div>
                ) : null}
                {emailStage === 'idle' ? (
                  <form onSubmit={requestEmailCode} className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label" htmlFor="newEmail">
                        新邮箱
                      </label>
                      <input
                        id="newEmail"
                        type="email"
                        required
                        className="field"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="name@example.com"
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="emailPassword">
                        当前密码
                      </label>
                      <input
                        id="emailPassword"
                        type="password"
                        required
                        className="field"
                        value={emailPassword}
                        onChange={(e) => setEmailPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </div>
                    {emailError ? (
                      <div className="sm:col-span-2">
                        <Alert tone="error">{emailError}</Alert>
                      </div>
                    ) : null}
                    <div className="sm:col-span-2">
                      <button type="submit" className="btn-primary" disabled={emailBusy}>
                        {emailBusy ? <Spinner /> : <Mail className="h-4 w-4" />} 发送验证码
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={verifyEmail} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <label className="label" htmlFor="emailCode">
                        验证码
                      </label>
                      <input
                        id="emailCode"
                        inputMode="numeric"
                        pattern="\d{6}"
                        maxLength={6}
                        required
                        className="field tracking-[0.4em]"
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                        placeholder="000000"
                      />
                    </div>
                    <button type="submit" className="btn-primary" disabled={emailBusy}>
                      {emailBusy ? <Spinner /> : <Check className="h-4 w-4" />} 确认更换
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setEmailStage('idle');
                        setEmailCode('');
                        setEmailError('');
                      }}
                    >
                      取消
                    </button>
                    {emailError ? (
                      <div className="w-full">
                        <Alert tone="error">{emailError}</Alert>
                      </div>
                    ) : null}
                  </form>
                )}
              </section>
            </>
          ) : null}

          {tab === 'security' ? (
            <>
              <section className="panel p-5 sm:p-6">
                <h2 className="text-[16px] font-semibold text-white">修改密码</h2>
                <p className="mt-1 text-[12.5px] text-white/40">
                  修改后所有其他设备将退出登录。密码使用 Argon2id 加盐哈希保存。
                </p>
                <form onSubmit={changePassword} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor="currentPassword">
                      当前密码
                    </label>
                    <input
                      id="currentPassword"
                      type="password"
                      required
                      className="field"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="newPassword">
                      新密码
                    </label>
                    <input
                      id="newPassword"
                      type="password"
                      required
                      minLength={10}
                      className="field"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="confirmPassword">
                      确认新密码
                    </label>
                    <input
                      id="confirmPassword"
                      type="password"
                      required
                      className="field"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  <p className="text-[11.5px] text-white/35 sm:col-span-2">
                    至少 10 位，需包含大小写字母、数字；不能包含用户名或邮箱。
                  </p>
                  {passwordError ? (
                    <div className="sm:col-span-2">
                      <Alert tone="error">{passwordError}</Alert>
                    </div>
                  ) : null}
                  <div className="sm:col-span-2">
                    <button type="submit" className="btn-primary" disabled={passwordBusy}>
                      {passwordBusy ? <Spinner /> : <KeyRound className="h-4 w-4" />} 更新密码
                    </button>
                  </div>
                </form>
              </section>

              <section className="panel p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[16px] font-semibold text-white">登录设备</h2>
                    <p className="mt-1 text-[12.5px] text-white/40">会话凭据仅保存在服务器，浏览器只持有随机令牌。</p>
                  </div>
                  <button type="button" className="btn-ghost" onClick={revokeOthers}>
                    <LogOut className="h-4 w-4" /> 退出其他设备
                  </button>
                </div>
                <div className="mt-4 space-y-2">
                  {sessionsLoading ? (
                    <LoadingBlock label="加载登录设备" />
                  ) : sessions.length === 0 ? (
                    <EmptyState icon={<Laptop className="h-5 w-5" />} title="暂无活动会话" />
                  ) : (
                    sessions.map((session) => (
                      <div
                        key={session.id}
                        className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                      >
                        <Laptop className="h-4 w-4 shrink-0 text-white/35" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] text-white/75">
                            {session.userAgent || '未知设备'}
                            {session.current ? <span className="badge badge-green ml-2">当前设备</span> : null}
                          </div>
                          <div className="mt-0.5 text-[11.5px] text-white/35">
                            IP {session.ip || '—'} · 最近活动 {timeAgo(session.lastSeenAt)} · 登录于 {formatDateTime(session.createdAt)}
                          </div>
                        </div>
                        {session.current ? (
                          <span className="text-[11.5px] text-white/30">正在使用</span>
                        ) : (
                          <button type="button" className="btn-icon" onClick={() => revokeSession(session.id)} aria-label="注销该设备">
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          ) : null}

          {tab === 'models' ? (
            <section className="panel p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-semibold text-white">我的 AI 模型</h2>
                  <p className="mt-1 text-[12.5px] text-white/40">
                    个人模型仅自己可见。API Key 使用 AES-256-GCM 加密存储，永不返回浏览器。
                  </p>
                  {defaultProvider ? (
                    <p className="mt-1 text-[12px] text-emerald-300/70">当前默认：{defaultProvider.name}</p>
                  ) : (
                    <p className="mt-1 text-[12px] text-white/35">未设置个人默认模型，将使用管理员配置的全局模型。</p>
                  )}
                </div>
                <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> 添加模型
                </button>
              </div>

              <div className="mt-5 space-y-2.5">
                {providersLoading ? (
                  <LoadingBlock label="加载模型配置" />
                ) : providers.length === 0 ? (
                  <EmptyState
                    icon={<Bot className="h-5 w-5" />}
                    title="尚未添加个人模型"
                    description="支持任意 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、本地 Ollama 等）。"
                    action={
                      <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                        添加第一个模型
                      </button>
                    }
                  />
                ) : (
                  providers.map((provider) => (
                    <div key={provider.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[14px] font-medium text-white/90">{provider.name}</span>
                            {provider.isDefault ? <span className="badge badge-green">默认</span> : null}
                            {provider.enabled ? (
                              <span className="badge badge-blue">启用</span>
                            ) : (
                              <span className="badge">已停用</span>
                            )}
                            {provider.ownerType === 'USER' ? <span className="badge">个人</span> : <span className="badge">全局</span>}
                          </div>
                          <div className="mt-1 break-all text-[11.5px] text-white/35">
                            {provider.modelId} · {provider.baseUrl}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {provider.capabilities.map((cap) => (
                              <span key={cap} className="chip !px-2 !py-0.5 !text-[10.5px]">
                                {CAPS.find((item) => item.key === cap)?.label ?? cap}
                              </span>
                            ))}
                          </div>
                        </div>
                        {provider.ownerType === 'USER' ? (
                          <div className="flex flex-wrap gap-1.5">
                            <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => setEditing(provider)}>
                              编辑
                            </button>
                            <button
                              type="button"
                              className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                              disabled={testingId === provider.id}
                              onClick={() => testProvider(provider)}
                            >
                              {testingId === provider.id ? <Spinner /> : null} 测试
                            </button>
                            <button
                              type="button"
                              className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                              onClick={() => toggleProvider(provider, { isDefault: true })}
                            >
                              设为默认
                            </button>
                            <button
                              type="button"
                              className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                              onClick={() => toggleProvider(provider, { enabled: !provider.enabled })}
                            >
                              {provider.enabled ? '停用' : '启用'}
                            </button>
                            <button
                              type="button"
                              className="btn-icon text-red-300/70 hover:text-red-200"
                              onClick={() => deleteProvider(provider)}
                              aria-label="删除模型"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ) : null}
                      </div>
                      {testResult?.id === provider.id ? (
                        <div className="mt-3">
                          <Alert tone={testResult.ok ? 'success' : 'error'}>{testResult.detail}</Alert>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </section>
          ) : null}

          {tab === 'about' ? (
            <section className="panel space-y-5 p-5 sm:p-6">
              <h2 className="text-[16px] font-semibold text-white">安全与隐私说明</h2>
              <div className="space-y-3 text-[13px] leading-relaxed text-white/60">
                <p className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                  账号密码使用 Argon2id 加盐哈希；会话令牌仅以 SHA-256 摘要形式存储在数据库中，浏览器持有 HTTP-only Cookie。
                </p>
                <p className="flex gap-2">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                  聊天内容、标题与附件在上传/写入数据库前使用 AES-256-GCM 加密，并绑定所属用户与记录 ID；附件文件落盘时同样加密。
                </p>
                <p className="flex gap-2">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                  AI 服务 API Key 加密保存，任何页面或接口都不会返回完整密钥；密钥主环保存在数据库与环境变量之外。
                </p>
                <p className="flex gap-2">
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  重要说明：为保证 AI 回复，发送消息时相关内容会传输给你选择的第三方 AI 服务商，这不是端到端加密。请勿发送不希望第三方看到的敏感信息。
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-[12px] leading-relaxed text-white/40">
                数据导出、审计日志与备份由超级管理员管理。如发现账号异常，请立即修改密码并联系管理员。
              </div>
            </section>
          ) : null}
        </div>
      </main>

      <ProviderModal
        open={creating || !!editing}
        provider={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(saved) => {
          setProviders((prev) => {
            const exists = prev.some((item) => item.id === saved.id);
            return exists ? prev.map((item) => (item.id === saved.id ? saved : item)) : [...prev, saved];
          });
          setCreating(false);
          setEditing(null);
          push('模型配置已保存');
        }}
      />
    </div>
  );
}


function ProviderModal({
  open,
  provider,
  onClose,
  onSaved
}: {
  open: boolean;
  provider: ProviderDto | null;
  onClose: () => void;
  onSaved: (provider: ProviderDto) => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [capabilities, setCapabilities] = useState<ProviderDto['capabilities']>(['text']);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    if (provider) {
      setName(provider.name);
      setBaseUrl(provider.baseUrl);
      setApiKey('');
      setModelId(provider.modelId);
      setCapabilities(provider.capabilities);
      setTemperature(provider.params?.temperature !== undefined ? String(provider.params.temperature) : '');
      setMaxTokens(provider.params?.maxTokens !== undefined ? String(provider.params.maxTokens) : '');
      setEnabled(provider.enabled);
      setIsDefault(provider.isDefault);
    } else {
      setName('');
      setBaseUrl('https://api.openai.com/v1');
      setApiKey('');
      setModelId('');
      setCapabilities(['text']);
      setTemperature('');
      setMaxTokens('');
      setEnabled(true);
      setIsDefault(false);
    }
  }, [open, provider]);

  function toggleCap(cap: ProviderDto['capabilities'][number]) {
    setCapabilities((prev) => (prev.includes(cap) ? prev.filter((item) => item !== cap) : [...prev, cap]));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!capabilities.length) {
      setError('至少选择一种能力');
      return;
    }
    const params: { temperature?: number; maxTokens?: number } = {};
    if (temperature.trim()) params.temperature = Number(temperature);
    if (maxTokens.trim()) params.maxTokens = Number(maxTokens);
    const payload: Record<string, unknown> = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      capabilities,
      enabled,
      isDefault
    };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    if (Object.keys(params).length) payload.params = params;
    if (!provider) {
      if (!payload.apiKey) {
        setError('新增模型必须填写 API Key');
        return;
      }
    }
    setBusy(true);
    try {
      const data = await apiFetch<{ provider: ProviderDto }>('/api/account/providers', {
        method: provider ? 'PATCH' : 'POST',
        json: provider ? { id: provider.id, ...payload } : payload
      });
      onSaved(data.provider);
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
      title={provider ? '编辑模型' : '添加个人模型'}
      description="兼容 OpenAI Chat Completions 接口。服务端会校验地址，禁止访问内网与保留地址。"
      width="620px"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">显示名称</label>
            <input className="field" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：DeepSeek V3" />
          </div>
          <div>
            <label className="label">模型 ID</label>
            <input className="field" required maxLength={128} value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="deepseek-chat" />
          </div>
        </div>
        <div>
          <label className="label">Base URL</label>
          <input
            className="field"
            required
            maxLength={512}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
          <p className="mt-1 text-[11px] text-white/30">填写到 /v1 即可，系统会自动拼接 /chat/completions 与 /models。</p>
        </div>
        <div>
          <label className="label">API Key</label>
          <input
            className="field"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            placeholder={provider ? '留空则保持不变' : 'sk-…'}
          />
        </div>
        <div>
          <div className="label">能力</div>
          <div className="flex flex-wrap gap-2">
            {CAPS.map((cap) => (
              <button
                key={cap.key}
                type="button"
                onClick={() => toggleCap(cap.key)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-[12px] transition',
                  capabilities.includes(cap.key)
                    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                    : 'border-white/10 text-white/45 hover:border-white/20'
                )}
              >
                {cap.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Temperature（可选）</label>
            <input
              className="field"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="0.7"
            />
          </div>
          <div>
            <label className="label">最大输出 Token（可选）</label>
            <input
              className="field"
              type="number"
              min={1}
              max={64000}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="4096"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[12.5px] text-white/60">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-emerald-400" />
            启用此模型
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-white/60">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="accent-emerald-400" />
            设为我的默认模型
          </label>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner /> : null} 保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
