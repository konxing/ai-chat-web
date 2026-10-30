'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Clock,
  Copy,
  Globe2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Wifi
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
import type { AdminIpRule } from '@/lib/admin-types';

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusBadge(rule: AdminIpRule) {
  if (rule.status === 'active') return <span className="badge badge-green">生效中</span>;
  if (rule.status === 'expired') return <span className="badge badge-amber">已过期</span>;
  return <span className="badge">已停用</span>;
}

export function IpRulesTab() {
  const { requestPassword } = useReauth();
  const { confirm } = useConfirm();
  const { push } = useToast();
  const [rules, setRules] = useState<AdminIpRule[]>([]);
  const [currentIp, setCurrentIp] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminIpRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<{ rules: AdminIpRule[]; currentIp: string }>('/api/admin/ip-rules');
      setRules(data.rules);
      setCurrentIp(data.currentIp);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function allowCurrentIp(hours: number | null) {
    if (!currentIp) {
      push('无法识别当前 IP，不能快捷添加规则', 'error');
      return;
    }
    setQuickBusy(true);
    try {
      const password = await requestPassword(
        `将当前 IP ${currentIp} 加入白名单${hours ? `（${hours} 小时后自动过期）` : '（长期有效）'}。`
      );
      if (!password) return;
      await apiFetch('/api/admin/ip-rules', {
        method: 'POST',
        json: {
          cidr: currentIp,
          label: hours ? `临时允许 ${currentIp}` : `允许 ${currentIp}`,
          enabled: true,
          expiresAt: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
          confirmPassword: password
        }
      });
      push('白名单规则已添加');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setQuickBusy(false);
    }
  }

  async function toggle(rule: AdminIpRule) {
    const ok = await confirm({
      title: rule.enabled ? `停用规则「${rule.label}」？` : `启用规则「${rule.label}」？`,
      description: rule.enabled
        ? '停用后，只有该规则覆盖的 IP 将立即失去访问权限（除非命中其他规则）。'
        : '启用后，该规则覆盖的 IP 将可以访问站点。',
      confirmText: rule.enabled ? '停用' : '启用',
      tone: rule.enabled ? 'danger' : 'primary'
    });
    if (!ok) return;
    const password = await requestPassword('修改 IP 白名单需要验证管理员身份。');
    if (!password) return;
    try {
      await apiFetch(`/api/admin/ip-rules/${rule.id}`, {
        method: 'PATCH',
        json: { enabled: !rule.enabled, confirmPassword: password }
      });
      push('规则已更新');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function remove(rule: AdminIpRule) {
    const ok = await confirm({
      title: `删除规则「${rule.label}」？`,
      description: `规则 ${rule.cidr} 将被立即移除。若该规则覆盖你当前的访问 IP，系统会阻止此操作以防锁死。`,
      confirmText: '删除规则',
      tone: 'danger'
    });
    if (!ok) return;
    const password = await requestPassword('删除 IP 白名单需要验证管理员身份。');
    if (!password) return;
    try {
      await apiFetch(`/api/admin/ip-rules/${rule.id}`, {
        method: 'DELETE',
        json: { confirmPassword: password }
      });
      push('规则已删除');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-white">IP 白名单</h1>
          <p className="mt-1 text-[12.5px] text-white/40">
            默认拒绝所有 IP。规则在应用最外层生效，覆盖首页、登录、API、静态资源与文件。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button type="button" className="btn-ghost" disabled={quickBusy || !currentIp} onClick={() => allowCurrentIp(24)}>
            {quickBusy ? <Spinner /> : <Clock className="h-4 w-4" />} 临时允许当前 IP（24h）
          </button>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 添加规则
          </button>
        </div>
      </div>

      <section className="panel flex flex-wrap items-center gap-4 p-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-400/10">
          <Wifi className="h-5 w-5 text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] text-white/35">当前公网 IP（经可信代理解析，不接受客户端伪造）</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[15px] text-white/85">
            {currentIp || '未知'}
            {currentIp ? (
              <button
                type="button"
                className="btn-icon !h-7 !w-7"
                onClick={() => {
                  void navigator.clipboard?.writeText(currentIp).then(
                    () => push('IP 已复制'),
                    () => push('复制失败', 'error')
                  );
                }}
                aria-label="复制 IP"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-amber-100/70">
          修改白名单前建议先添加新 IP，再删除旧规则。
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {loading && rules.length === 0 ? (
        <LoadingBlock label="加载白名单" />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<ShieldOff className="h-5 w-5" />}
          title="白名单为空"
          description="当前所有外部访问都会被拒绝。请先通过服务器本地通道添加至少一个允许 IP，避免把自己锁在外面。"
          action={
            <button type="button" className="btn-primary" disabled={!currentIp} onClick={() => allowCurrentIp(24)}>
              允许当前 IP（24h）
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <section key={rule.id} className="panel p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Globe2 className="h-4 w-4 shrink-0 text-white/30" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13.5px] text-white/85">{rule.cidr}</span>
                    {statusBadge(rule)}
                    {!rule.enabled ? <span className="badge badge-red">未启用</span> : null}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-white/40">{rule.label}</div>
                  <div className="mt-1 text-[11px] text-white/25">
                    创建 {formatDateTime(rule.createdAt)} · 更新 {timeAgo(rule.updatedAt)}
                    {rule.expiresAt ? ` · 过期时间 ${formatDateTime(rule.expiresAt)}` : ' · 长期有效'}
                    {rule.lastMatchedAt ? ` · 最近命中 ${timeAgo(rule.lastMatchedAt)}` : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button type="button" className="btn-icon" title="编辑规则" onClick={() => setEditing(rule)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    title={rule.enabled ? '停用规则' : '启用规则'}
                    onClick={() => toggle(rule)}
                  >
                    {rule.enabled ? <ShieldOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    className="btn-icon text-red-300/70 hover:text-red-200"
                    title="删除规则"
                    onClick={() => remove(rule)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      <RuleModal
        open={creating || Boolean(editing)}
        rule={editing}
        currentIp={currentIp}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          void load();
        }}
      />

      <div className="panel p-5">
        <h2 className="text-[14px] font-semibold text-white">三层防护说明</h2>
        <div className="mt-3 grid gap-3 text-[12px] leading-relaxed text-white/45 md:grid-cols-3">
          <div className="rounded-xl bg-white/[0.03] p-3.5">
            <div className="mb-1 font-medium text-white/70">1. 云安全组</div>
            在 VPS 防火墙之前丢弃非白名单流量，减少暴露面。需按部署文档同步规则。
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3.5">
            <div className="mb-1 font-medium text-white/70">2. nftables</div>
            主机层默认拒绝，仅放行白名单与 SSH 管理地址。规则由脚本从同一来源生成。
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3.5">
            <div className="mb-1 font-medium text-white/70">3. 应用网关</div>
            Nginx 与应用内网关再次校验。应用层缓存约 1 秒，删除规则后立即生效。
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleModal({
  open,
  rule,
  currentIp,
  onClose,
  onSaved
}: {
  open: boolean;
  rule: AdminIpRule | null;
  currentIp: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { requestPassword } = useReauth();
  const { push } = useToast();
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    if (rule) {
      setCidr(rule.cidr);
      setLabel(rule.label);
      setEnabled(rule.enabled);
      setExpiresAt(toLocalInput(rule.expiresAt));
    } else {
      setCidr('');
      setLabel('');
      setEnabled(true);
      setExpiresAt('');
    }
  }, [open, rule]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const password = await requestPassword(
      rule ? `修改白名单规则「${rule.label}」需要验证管理员身份。` : '添加 IP 白名单需要验证管理员身份。'
    );
    if (!password) return;
    setBusy(true);
    try {
      const payload = {
        cidr: cidr.trim(),
        label: label.trim() || cidr.trim(),
        enabled,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        confirmPassword: password
      };
      if (rule) {
        await apiFetch(`/api/admin/ip-rules/${rule.id}`, { method: 'PATCH', json: payload });
      } else {
        await apiFetch('/api/admin/ip-rules', { method: 'POST', json: payload });
      }
      push(rule ? '规则已更新' : '规则已添加');
      onSaved();
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
      title={rule ? '编辑白名单规则' : '添加白名单规则'}
      description="支持单个 IPv4/IPv6 地址或 CIDR 网段，例如 203.0.113.7、203.0.113.0/24、2001:db8::/32。"
      width="540px"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">IP / CIDR</label>
          <input
            className="field font-mono"
            required
            maxLength={64}
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            placeholder={currentIp || '203.0.113.7 或 203.0.113.0/24'}
          />
          {currentIp && !cidr ? (
            <button
              type="button"
              className="mt-1 text-[11.5px] text-emerald-300/80 hover:text-emerald-200"
              onClick={() => setCidr(currentIp)}
            >
              填入当前 IP（{currentIp}）
            </button>
          ) : null}
        </div>
        <div>
          <label className="label">备注</label>
          <input className="field" maxLength={128} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 家里宽带" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">过期时间（可选）</label>
            <input
              className="field"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-white/30">留空表示长期有效。过期后自动失效，无需手动删除。</p>
          </div>
          <label className="flex items-center gap-2 self-start rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-[12.5px] text-white/60 sm:mt-6">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-emerald-400" />
            立即启用
          </label>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner /> : null} 保存规则
          </button>
        </div>
      </form>
    </Modal>
  );
}
