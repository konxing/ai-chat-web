'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowLeft,
  Bot,
  ChevronRight,
  Database,
  FileClock,
  Gauge,
  HardDrive,
  KeyRound,
  Layers,
  LogIn,
  MessageSquare,
  RefreshCw,
  Save,
  ScrollText,
  Server,
  Settings2,
  Shield,
  ShieldAlert,
  UserRound,
  Users,
  Wifi
} from 'lucide-react';
import { apiFetch, errorMessage, formatBytes, formatDateTime, formatDuration, formatNumber } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { BrandMark } from '@/components/brand';
import {
  Alert,
  ConfirmProvider,
  LoadingBlock,
  ReauthProvider,
  Spinner,
  ToastProvider,
  useReauth,
  useToast
} from '@/components/ui';
import type { AdminOverview, ServiceStatus } from '@/lib/admin-types';
import type { ProviderDto } from '@/lib/chat-types';
import { UsersTab } from '@/components/admin/users-tab';
import { IpRulesTab } from '@/components/admin/ip-rules-tab';
import { LogsTab } from '@/components/admin/logs-tab';
import { ModelsTab } from '@/components/admin/models-tab';
import { StorageTab } from '@/components/admin/storage-tab';

type Tab =
  | 'overview'
  | 'users'
  | 'ip'
  | 'config'
  | 'models'
  | 'login'
  | 'audit'
  | 'access'
  | 'storage'
  | 'service';

const NAV: Array<{ key: Tab; label: string; icon: typeof Gauge; group: string }> = [
  { key: 'overview', label: '安全概览', icon: Gauge, group: '总览' },
  { key: 'users', label: '用户管理', icon: Users, group: '访问控制' },
  { key: 'ip', label: 'IP 白名单', icon: Wifi, group: '访问控制' },
  { key: 'login', label: '登录记录', icon: LogIn, group: '访问控制' },
  { key: 'audit', label: '审计日志', icon: ScrollText, group: '访问控制' },
  { key: 'access', label: '访问日志', icon: FileClock, group: '访问控制' },
  { key: 'models', label: '全局模型', icon: Bot, group: '系统' },
  { key: 'config', label: '系统配置', icon: Settings2, group: '系统' },
  { key: 'storage', label: '存储与备份', icon: HardDrive, group: '系统' },
  { key: 'service', label: '服务状态', icon: Server, group: '系统' }
];

export function AdminWorkspace({ owner }: { owner: { username: string; displayName: string | null } }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <ReauthProvider>
          <AdminShell owner={owner} />
        </ReauthProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AdminShell({ owner }: { owner: { username: string; displayName: string | null } }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [navOpen, setNavOpen] = useState(false);
  const groups = Array.from(new Set(NAV.map((item) => item.group)));

  return (
    <div className="relative min-h-[100dvh]">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(55%_45%_at_15%_0%,rgba(245,158,11,0.07),transparent_60%),radial-gradient(45%_40%_at_90%_10%,rgba(99,102,241,0.10),transparent_60%)]" />
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#07090f]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <Link href="/chat" className="btn-icon" aria-label="返回对话">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <BrandMark className="h-8 w-8" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
              管理后台
              <span className="badge badge-amber">超级管理员</span>
            </div>
            <div className="truncate text-[11px] text-white/35">{owner.displayName || owner.username} · 所有敏感操作均需二次验证</div>
          </div>
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <Link href="/settings" className="btn-ghost">
              <Settings2 className="h-4 w-4" /> 设置
            </Link>
            <Link href="/chat" className="btn-ghost">
              返回对话
            </Link>
          </div>
          <button type="button" className="btn-icon sm:hidden" onClick={() => setNavOpen((v) => !v)} aria-label="切换菜单">
            <Layers className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <nav className={cn('space-y-5 lg:block', navOpen ? 'block' : 'hidden')}>
          {groups.map((group) => (
            <div key={group}>
              <div className="px-3 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white/25">{group}</div>
              <div className="mt-1.5 space-y-0.5">
                {NAV.filter((item) => item.group === group).map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        setTab(item.key);
                        setNavOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] transition',
                        tab === item.key
                          ? 'bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                          : 'text-white/50 hover:bg-white/[0.04] hover:text-white/80'
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {item.label}
                      {tab === item.key ? <ChevronRight className="ml-auto h-3.5 w-3.5 text-white/30" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="min-w-0">
          {tab === 'overview' ? <OverviewTab onNavigate={setTab} /> : null}
          {tab === 'users' ? <UsersTab /> : null}
          {tab === 'ip' ? <IpRulesTab /> : null}
          {tab === 'login' ? <LogsTab mode="login" /> : null}
          {tab === 'audit' ? <LogsTab mode="audit" /> : null}
          {tab === 'access' ? <LogsTab mode="access" /> : null}
          {tab === 'models' ? <ModelsTab /> : null}
          {tab === 'config' ? <ConfigTab /> : null}
          {tab === 'storage' ? <StorageTab /> : null}
          {tab === 'service' ? <ServiceTab /> : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Overview -------------------------------- */

function OverviewTab({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await apiFetch<AdminOverview>('/api/admin/overview'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <LoadingBlock label="加载安全概览" />;

  const stats = [
    { label: '用户', value: formatNumber(data.users.total), sub: `${data.users.active} 启用 · ${data.users.disabled} 停用`, icon: Users, tone: 'text-sky-300' },
    { label: '最近 24h 登录', value: formatNumber(data.access.logins24h), sub: `活跃会话 ${data.access.sessions}`, icon: LogIn, tone: 'text-emerald-300' },
    { label: '拒绝访问（24h）', value: formatNumber(data.access.denied24h), sub: '非白名单 IP 请求', icon: ShieldAlert, tone: 'text-red-300' },
    { label: '会话 / 消息', value: `${formatNumber(data.chats.total)} / ${formatNumber(data.chats.messages)}`, sub: `附件 ${formatNumber(data.storage.attachments)} 个`, icon: MessageSquare, tone: 'text-indigo-300' }
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="panel p-4">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-white/40">{item.label}</span>
                <Icon className={cn('h-4 w-4', item.tone)} />
              </div>
              <div className="mt-2 text-[26px] font-semibold leading-none tracking-tight text-white">{item.value}</div>
              <div className="mt-2 text-[11.5px] text-white/35">{item.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="panel p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-white">网络访问控制</h2>
            <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => onNavigate('ip')}>
              管理白名单
            </button>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <MiniStat label="白名单规则" value={data.access.rules} />
            <MiniStat label="生效中" value={data.access.activeRules} tone="text-emerald-300" />
            <MiniStat label="活跃会话" value={data.access.sessions} />
          </div>
          <div className="mt-4 rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-4 py-3 text-[12px] leading-relaxed text-amber-100/70">
            默认拒绝：只有命中白名单规则的 IP 才能访问站点。所有允许/拒绝均记录在访问日志中，删除规则会立即生效。
          </div>
        </section>

        <section className="panel p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-white">模型与存储</h2>
            <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => onNavigate('models')}>
              管理模型
            </button>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <MiniStat label="全局模型" value={data.models.global} />
            <MiniStat label="个人模型" value={data.models.user} />
            <MiniStat label="启用总数" value={data.models.enabled} tone="text-emerald-300" />
          </div>
          <div className="mt-4 space-y-2 text-[12.5px] text-white/50">
            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
              <span>附件占用</span>
              <span className="text-white/70">{formatBytes(data.storage.bytes)}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
              <span>上传目录</span>
              <span className="text-white/70">{formatBytes(data.storage.uploadsBytes)}</span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-white">服务状态</h2>
          <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => onNavigate('service')}>
            查看详情
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MiniStat label="运行时长" value={formatDuration(data.service.uptimeSeconds)} />
          <MiniStat
            label="数据库"
            value={data.service.database.ok ? `${data.service.database.latencyMs} ms` : '异常'}
            tone={data.service.database.ok ? 'text-emerald-300' : 'text-red-300'}
          />
          <MiniStat label="磁盘剩余" value={data.service.disk ? formatBytes(data.service.disk.freeBytes) : '—'} />
          <MiniStat label="内存占用" value={`${formatBytes(data.service.memory.rssBytes)}`} />
        </div>
      </section>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-3.5 py-3">
      <div className="text-[11px] text-white/35">{label}</div>
      <div className={cn('mt-1 text-[17px] font-semibold text-white', tone)}>{value}</div>
    </div>
  );
}

/* -------------------------------- Config -------------------------------- */

function ConfigTab() {
  const { requestPassword } = useReauth();
  const { push } = useToast();
  const [loading, setLoading] = useState(true);
  const [siteName, setSiteName] = useState('');
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [defaultProviderId, setDefaultProviderId] = useState('');
  const [maxUploadMB, setMaxUploadMB] = useState(20);
  const [maintenanceNotice, setMaintenanceNotice] = useState('');
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{
        settings: { siteName: string; registrationOpen: boolean; defaultProviderId: string | null; maxUploadMB: number; maintenanceNotice: string };
        providers: ProviderDto[];
      }>('/api/admin/config');
      setSiteName(data.settings.siteName);
      setRegistrationOpen(data.settings.registrationOpen);
      setDefaultProviderId(data.settings.defaultProviderId ?? '');
      setMaxUploadMB(data.settings.maxUploadMB);
      setMaintenanceNotice(data.settings.maintenanceNotice);
      setProviders(data.providers);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const password = await requestPassword('保存系统配置需要验证管理员身份。');
    if (!password) return;
    setBusy(true);
    try {
      await apiFetch('/api/admin/config', {
        method: 'PATCH',
        json: {
          siteName: siteName.trim(),
          registrationOpen,
          defaultProviderId: defaultProviderId || null,
          maxUploadMB,
          maintenanceNotice,
          confirmPassword: password
        }
      });
      push('系统配置已保存');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingBlock label="加载系统配置" />;

  return (
    <form onSubmit={save} className="space-y-5">
      <section className="panel p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-white">站点</h2>
        <p className="mt-1 text-[12.5px] text-white/40">站点名称与公告会展示在登录页和聊天界面。</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">站点名称</label>
            <input className="field" required maxLength={80} value={siteName} onChange={(e) => setSiteName(e.target.value)} />
          </div>
          <div>
            <label className="label">单文件上传上限（MB）</label>
            <input
              className="field"
              type="number"
              min={1}
              max={100}
              value={maxUploadMB}
              onChange={(e) => setMaxUploadMB(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">维护公告（留空则不显示）</label>
            <textarea
              className="field min-h-[90px] resize-y"
              maxLength={500}
              value={maintenanceNotice}
              onChange={(e) => setMaintenanceNotice(e.target.value)}
              placeholder="例如：今晚 23:00 进行备份维护，期间服务可能短暂中断。"
            />
          </div>
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-white">访问与注册</h2>
        <div className="mt-4 space-y-4">
          <label className="flex items-start justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
            <div>
              <div className="text-[13px] font-medium text-white/80">开放邮箱注册</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-white/35">
                关闭后，新用户只能由超级管理员创建。已登录用户不受影响。
              </div>
            </div>
            <input
              type="checkbox"
              className="mt-1 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-white/10 transition checked:bg-emerald-400/80 relative before:absolute before:top-0.5 before:left-0.5 before:h-4 before:w-4 before:rounded-full before:bg-white before:transition checked:before:translate-x-4"
              checked={registrationOpen}
              onChange={(e) => setRegistrationOpen(e.target.checked)}
            />
          </label>
          <div>
            <label className="label">默认全局模型</label>
            <select className="field" value={defaultProviderId} onChange={(e) => setDefaultProviderId(e.target.value)}>
              <option value="">自动选择（优先级：个人默认 → 全局默认 → 任一启用）</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}（{provider.modelId}）
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-white">安全提示</h2>
        <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-white/45">
          <li className="flex gap-2">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
            注册开关与白名单变更都会写入审计日志，包含操作者、时间、IP 与前后值。
          </li>
          <li className="flex gap-2">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
            所有管理员敏感操作（配置、用户、白名单、模型、备份）均要求重新输入当前密码。
          </li>
        </ul>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Spinner /> : <Save className="h-4 w-4" />} 保存配置
        </button>
      </div>
    </form>
  );
}

/* -------------------------------- Service -------------------------------- */

function ServiceTab() {
  const [data, setData] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await apiFetch<ServiceStatus>('/api/admin/service'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) return <LoadingBlock label="加载服务状态" />;
  if (error && !data) return <Alert tone="error">{error}</Alert>;
  if (!data) return null;

  const memPercent = Math.round((data.memory.rssBytes / Math.max(1, data.memory.systemTotalBytes)) * 1000) / 10;
  const diskPercent = data.disk ? Math.round(((data.disk.totalBytes - data.disk.freeBytes) / Math.max(1, data.disk.totalBytes)) * 1000) / 10 : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-white">服务状态</h1>
          <p className="mt-1 text-[12.5px] text-white/40">每 30 秒自动刷新。数据库异常会在此处显示。</p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" /> 立即刷新
        </button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
            <Activity className="h-4 w-4 text-emerald-300" /> 运行信息
          </h2>
          <dl className="mt-4 space-y-2.5 text-[12.5px]">
            <Row label="运行时长" value={formatDuration(data.uptimeSeconds)} />
            <Row label="启动时间" value={formatDateTime(data.startedAt)} />
            <Row label="Node 版本" value={data.nodeVersion} />
            <Row label="平台" value={data.platform} />
            <Row label="环境" value={data.nodeEnv} />
            <Row label="站点地址" value={data.appUrl} />
            <Row label="负载" value={data.loadAverage.join(' / ')} />
          </dl>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
            <Database className="h-4 w-4 text-sky-300" /> 数据库
          </h2>
          <dl className="mt-4 space-y-2.5 text-[12.5px]">
            <Row
              label="状态"
              value={data.database.ok ? '正常' : '异常'}
              valueClass={data.database.ok ? 'text-emerald-300' : 'text-red-300'}
            />
            <Row label="延迟" value={`${data.database.latencyMs} ms`} />
            <Row label="版本" value={data.database.version ?? '—'} />
            <Row label="大小" value={data.database.sizeBytes ? formatBytes(data.database.sizeBytes) : '—'} />
          </dl>
          <p className="mt-4 text-[11.5px] leading-relaxed text-white/30">
            数据库大小包含加密后的聊天内容、账号、会话、白名单与审计日志，不包含附件文件本身。
          </p>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
            <Gauge className="h-4 w-4 text-indigo-300" /> 内存
          </h2>
          <div className="mt-4 space-y-3">
            <Meter label="进程 RSS" percent={memPercent} detail={`${formatBytes(data.memory.rssBytes)} / 系统 ${formatBytes(data.memory.systemTotalBytes)}`} />
            <Meter
              label="Heap 使用"
              percent={Math.round((data.memory.heapUsedBytes / Math.max(1, data.memory.systemTotalBytes)) * 1000) / 10}
              detail={formatBytes(data.memory.heapUsedBytes)}
            />
            <div className="text-[11.5px] text-white/35">系统可用 {formatBytes(data.memory.systemFreeBytes)}</div>
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white">
            <HardDrive className="h-4 w-4 text-amber-300" /> 磁盘
          </h2>
          {data.disk ? (
            <div className="mt-4 space-y-3">
              <Meter
                label="上传目录占用"
                percent={diskPercent}
                detail={`剩余 ${formatBytes(data.disk.freeBytes)} / 共 ${formatBytes(data.disk.totalBytes)}`}
              />
              <div className="break-all text-[11.5px] text-white/35">{data.disk.path}</div>
            </div>
          ) : (
            <p className="mt-4 text-[12.5px] text-white/40">无法读取磁盘信息。</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.04] pb-2 last:border-0 last:pb-0">
      <dt className="shrink-0 text-white/35">{label}</dt>
      <dd className={cn('break-all text-right text-white/70', valueClass)}>{value}</dd>
    </div>
  );
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-white/45">{label}</span>
        <span className="text-white/65">{percent}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className={cn('h-full rounded-full', percent > 85 ? 'bg-red-400/80' : percent > 65 ? 'bg-amber-400/80' : 'bg-emerald-400/70')}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="mt-1 text-[11px] text-white/30">{detail}</div>
    </div>
  );
}
