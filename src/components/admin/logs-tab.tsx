'use client';

import { useCallback, useEffect, useState } from 'react';
import { Filter, RefreshCw, Search } from 'lucide-react';
import { apiFetch, errorMessage, formatDateTime, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { Alert, EmptyState, LoadingBlock, Spinner } from '@/components/ui';
import type { AccessLogItem, AuditLogItem, LoginLogItem, Paged } from '@/lib/admin-types';
import { Pagination } from '@/components/admin/users-tab';

type Mode = 'login' | 'audit' | 'access';

const TITLES: Record<Mode, { title: string; hint: string; endpoint: string }> = {
  login: {
    title: '登录记录',
    hint: '记录每一次登录尝试。密码、验证码与令牌不会写入日志。',
    endpoint: '/api/admin/logs/login'
  },
  audit: {
    title: '审计日志',
    hint: '记录管理员与用户的关键安全操作，包含操作前后值。敏感字段已脱敏。',
    endpoint: '/api/admin/logs/audit'
  },
  access: {
    title: '访问日志',
    hint: '记录被允许与拒绝的 IP、请求路径与时间。用于排查白名单与异常访问。',
    endpoint: '/api/admin/logs/access'
  }
};

type Filters = { ip: string; username: string; action: string; loginSuccess: string; allowed: string; from: string; to: string };

const EMPTY_FILTERS: Filters = { ip: '', username: '', action: '', loginSuccess: '', allowed: '', from: '', to: '' };

// 条件没变就沿用旧引用：让「点筛选」之后那个还在排队的防抖定时器变成空转，
// 不再触发第二次分页查询。
function sameFilters(a: Filters, b: Filters): boolean {
  return Object.keys(EMPTY_FILTERS).every((key) => a[key as keyof Filters] === b[key as keyof Filters]);
}

export function LogsTab({ mode }: { mode: Mode }) {
  const meta = TITLES[mode];
  const [ip, setIp] = useState('');
  const [username, setUsername] = useState('');
  const [action, setAction] = useState('');
  const [loginSuccess, setLoginSuccess] = useState('');
  const [allowed, setAllowed] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [data, setData] = useState<Paged<LoginLogItem | AuditLogItem | AccessLogItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function snapshot(): Filters {
    return { ip, username, action, loginSuccess, allowed, from, to };
  }

  function commitFilters(next: Filters) {
    setApplied((prev) => (sameFilters(prev, next) ? prev : next));
  }

  useEffect(() => {
    setData(null);
    setPage(1);
    setIp('');
    setUsername('');
    setAction('');
    setLoginSuccess('');
    setAllowed('');
    setFrom('');
    setTo('');
    commitFilters(EMPTY_FILTERS);
  }, [mode]);

  // 和 users-tab 同一个节奏：输入停顿 320ms 才把条件交给查询，
  // 否则每敲一个字符都要把三张日志表分页扫一遍。
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      commitFilters(snapshot());
    }, 320);
    return () => clearTimeout(timer);
  }, [ip, username, action, loginSuccess, allowed, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30' });
      if (applied.ip.trim()) params.set('ip', applied.ip.trim());
      if (applied.from) params.set('from', new Date(`${applied.from}T00:00:00`).toISOString());
      if (applied.to) params.set('to', new Date(`${applied.to}T23:59:59`).toISOString());
      if (mode === 'login') {
        if (applied.username.trim()) params.set('username', applied.username.trim());
        if (applied.loginSuccess) params.set('success', applied.loginSuccess);
      }
      if (mode === 'audit' && applied.action.trim()) params.set('action', applied.action.trim());
      if (mode === 'access' && applied.allowed) params.set('allowed', applied.allowed);
      setData(await apiFetch<Paged<LoginLogItem | AuditLogItem | AccessLogItem>>(`${meta.endpoint}?${params.toString()}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [applied, meta.endpoint, mode, page, reload]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters(event: React.FormEvent) {
    event.preventDefault();
    commitFilters(snapshot());
    setPage(1);
    setReload((v) => v + 1);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[18px] font-semibold text-white">{meta.title}</h1>
        <p className="mt-1 text-[12.5px] text-white/40">{meta.hint}</p>
      </div>

      <form onSubmit={applyFilters} className="panel grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        {mode === 'login' ? (
          <div>
            <label className="label">用户名</label>
            <input className="field" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="部分匹配" />
          </div>
        ) : null}
        {mode === 'audit' ? (
          <div>
            <label className="label">操作</label>
            <input className="field" value={action} onChange={(e) => setAction(e.target.value)} placeholder="例如 admin.ip_rule" />
          </div>
        ) : null}
        <div>
          <label className="label">IP</label>
          <input className="field font-mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="部分匹配" />
        </div>
        {mode === 'login' ? (
          <div>
            <label className="label">结果</label>
            <select className="field" value={loginSuccess} onChange={(e) => setLoginSuccess(e.target.value)}>
              <option value="">全部</option>
              <option value="true">成功</option>
              <option value="false">失败</option>
            </select>
          </div>
        ) : null}
        {mode === 'access' ? (
          <div>
            <label className="label">访问结果</label>
            <select className="field" value={allowed} onChange={(e) => setAllowed(e.target.value)}>
              <option value="">全部</option>
              <option value="true">允许</option>
              <option value="false">拒绝</option>
            </select>
          </div>
        ) : null}
        <div>
          <label className="label">开始日期</label>
          <input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">结束日期</label>
          <input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? <Spinner /> : <Filter className="h-4 w-4" />} 筛选
          </button>
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </form>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {loading && !data ? (
        <LoadingBlock label="加载日志" />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="没有匹配的记录"
          description="调整筛选条件后再试。"
        />
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            {mode === 'login' ? (
              <table className="table min-w-[820px]">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>用户</th>
                    <th>结果</th>
                    <th>IP</th>
                    <th>原因 / 设备</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.items as LoginLogItem[]).map((item) => (
                    <tr key={item.id}>
                      <td className="whitespace-nowrap text-white/50">{formatDateTime(item.createdAt)}</td>
                      <td className="text-white/75">{item.username || '—'}</td>
                      <td>
                        {item.success ? <span className="badge badge-green">成功</span> : <span className="badge badge-red">失败</span>}
                      </td>
                      <td className="font-mono text-[12px] text-white/50">{item.ip || '—'}</td>
                      <td>
                        <div className="text-[12px] text-white/45">{item.reason || '—'}</div>
                        <div className="max-w-[360px] truncate text-[11px] text-white/25">{item.userAgent || '—'}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {mode === 'audit' ? (
              <div className="divide-y divide-white/[0.05]">
                {(data.items as AuditLogItem[]).map((item) => (
                  <details key={item.id} className="group">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                      <span className="w-[140px] shrink-0 text-[11.5px] text-white/40">{formatDateTime(item.createdAt)}</span>
                      <span
                        className={cn(
                          'badge shrink-0',
                          item.status === 'FAILURE' ? 'badge-red' : 'badge-green'
                        )}
                      >
                        {item.status === 'FAILURE' ? '失败' : '成功'}
                      </span>
                      <span className="badge badge-blue shrink-0">{item.action}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-white/55">
                        {item.actorLabel || '系统'} · {item.targetType || '—'} {item.targetId ? `#${item.targetId}` : ''}
                      </span>
                      <span className="font-mono text-[11.5px] text-white/30">{item.ip || '—'}</span>
                    </summary>
                    <div className="grid gap-3 border-t border-white/[0.04] bg-black/20 px-4 py-3 lg:grid-cols-2">
                      <JsonBlock title="操作前" value={item.before} />
                      <JsonBlock title="操作后" value={item.after} />
                      {item.error ? (
                        <div className="lg:col-span-2">
                          <Alert tone="error">{item.error}</Alert>
                        </div>
                      ) : null}
                      <div className="text-[11px] text-white/25 lg:col-span-2">
                        设备：{item.userAgent || '—'} · 操作者 ID：{item.actorId || '—'}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            ) : null}

            {mode === 'access' ? (
              <table className="table min-w-[760px]">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>结果</th>
                    <th>IP</th>
                    <th>请求</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.items as AccessLogItem[]).map((item) => (
                    <tr key={item.id}>
                      <td className="whitespace-nowrap text-white/45">{timeAgo(item.createdAt)}</td>
                      <td>
                        {item.allowed ? <span className="badge badge-green">允许</span> : <span className="badge badge-red">拒绝</span>}
                      </td>
                      <td className="font-mono text-[12px] text-white/60">{item.ip}</td>
                      <td>
                        <span className="font-mono text-[11.5px] text-white/45">{item.method}</span>{' '}
                        <span className="break-all font-mono text-[11.5px] text-white/70">{item.path}</span>
                      </td>
                      <td className="text-[11.5px] text-white/35">{item.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} busy={loading} />
        </div>
      )}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-white/35">{title}</div>
      <pre className="max-h-56 overflow-auto rounded-lg border border-white/[0.05] bg-black/30 p-2.5 text-[11px] leading-relaxed text-white/50">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
