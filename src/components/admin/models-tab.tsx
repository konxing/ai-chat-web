'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, Pencil, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
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
import type { ProviderDto } from '@/lib/chat-types';

const CAPS: Array<{ key: ProviderDto['capabilities'][number]; label: string }> = [
  { key: 'text', label: '文本' },
  { key: 'vision', label: '图像理解' },
  { key: 'files', label: '文件' },
  { key: 'audio', label: '语音' }
];

export function ModelsTab() {
  const { requestPassword } = useReauth();
  const { confirm } = useConfirm();
  const { push } = useToast();
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ProviderDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [providerData, config] = await Promise.all([
        apiFetch<{ providers: ProviderDto[] }>('/api/admin/providers'),
        apiFetch<{ settings: { defaultProviderId: string | null } }>('/api/admin/config')
      ]);
      setProviders(providerData.providers);
      setDefaultId(config.settings.defaultProviderId ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeDefault(provider: ProviderDto) {
    const password = await requestPassword(`将「${provider.name}」设为全站默认模型需要验证管理员身份。`);
    if (!password) return;
    try {
      await apiFetch('/api/admin/config', {
        method: 'PATCH',
        json: { defaultProviderId: provider.id, confirmPassword: password }
      });
      setDefaultId(provider.id);
      push('已设为全站默认模型');
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function toggle(provider: ProviderDto) {
    const password = await requestPassword('启用/停用全局模型需要验证管理员身份。');
    if (!password) return;
    try {
      await apiFetch(`/api/admin/providers/${provider.id}`, {
        method: 'PATCH',
        json: { enabled: !provider.enabled, confirmPassword: password }
      });
      push(provider.enabled ? '模型已停用' : '模型已启用');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function remove(provider: ProviderDto) {
    const ok = await confirm({
      title: `删除全局模型「${provider.name}」？`,
      description: '使用该模型的会话将无法继续回复。个人用户的同名配置不受影响。',
      confirmText: '删除模型',
      tone: 'danger'
    });
    if (!ok) return;
    const password = await requestPassword('删除全局模型需要验证管理员身份。');
    if (!password) return;
    try {
      await apiFetch(`/api/admin/providers/${provider.id}`, {
        method: 'DELETE',
        json: { confirmPassword: password }
      });
      push('全局模型已删除');
      void load();
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  async function test(provider: ProviderDto) {
    setTestingId(provider.id);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; detail: string }>(`/api/admin/providers/${provider.id}/test`, {
        method: 'POST'
      });
      setTestResult({ id: provider.id, ...result });
    } catch (err) {
      setTestResult({ id: provider.id, ok: false, detail: errorMessage(err) });
    } finally {
      setTestingId('');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-white">全局 AI 模型</h1>
          <p className="mt-1 text-[12.5px] text-white/40">
            所有成员可用的模型。API Key 加密存储，仅服务端在调用时解密，永不返回浏览器。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 添加全局模型
          </button>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {loading && providers.length === 0 ? (
        <LoadingBlock label="加载模型" />
      ) : providers.length === 0 ? (
        <EmptyState
          icon={<Bot className="h-5 w-5" />}
          title="尚未配置全局模型"
          description="添加一个 OpenAI 兼容模型，或在系统配置中指定默认模型。家庭成员也可以添加自己的个人模型。"
          action={
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              添加第一个模型
            </button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          {providers.map((provider) => (
            <section key={provider.id} className="panel p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.05]">
                  <Bot className="h-5 w-5 text-white/50" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-white/90">{provider.name}</span>
                    {defaultId === provider.id ? (
                      <span className="badge badge-green">
                        <Star className="h-3 w-3" /> 系统默认
                      </span>
                    ) : null}
                    {provider.isDefault ? <span className="badge badge-blue">全局默认标记</span> : null}
                    {provider.enabled ? <span className="badge badge-green">启用</span> : <span className="badge">停用</span>}
                    {!provider.hasApiKey ? <span className="badge badge-red">缺少密钥</span> : null}
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
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className="btn-icon" title="编辑" onClick={() => setEditing(provider)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                    disabled={testingId === provider.id}
                    onClick={() => void test(provider)}
                  >
                    {testingId === provider.id ? <Spinner /> : null} 测试
                  </button>
                  <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => void makeDefault(provider)}>
                    设为系统默认
                  </button>
                  <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-[12px]" onClick={() => void toggle(provider)}>
                    {provider.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="btn-icon text-red-300/70 hover:text-red-200"
                    title="删除"
                    onClick={() => void remove(provider)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {testResult?.id === provider.id ? (
                <div className="mt-3">
                  <Alert tone={testResult.ok ? 'success' : 'error'}>{testResult.detail}</Alert>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}

      <GlobalProviderModal
        open={creating || Boolean(editing)}
        provider={editing}
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
    </div>
  );
}

function GlobalProviderModal({
  open,
  provider,
  onClose,
  onSaved
}: {
  open: boolean;
  provider: ProviderDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { requestPassword } = useReauth();
  const { push } = useToast();
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
    if (!provider && !apiKey.trim()) {
      setError('新增模型必须填写 API Key');
      return;
    }
    const password = await requestPassword(provider ? '修改全局模型需要验证管理员身份。' : '添加全局模型需要验证管理员身份。');
    if (!password) return;
    const params: { temperature?: number; maxTokens?: number } = {};
    if (temperature.trim()) params.temperature = Number(temperature);
    if (maxTokens.trim()) params.maxTokens = Number(maxTokens);
    const payload: Record<string, unknown> = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      capabilities,
      enabled,
      isDefault,
      confirmPassword: password
    };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    if (Object.keys(params).length) payload.params = params;
    setBusy(true);
    try {
      if (provider) {
        await apiFetch(`/api/admin/providers/${provider.id}`, { method: 'PATCH', json: payload });
      } else {
        await apiFetch('/api/admin/providers', { method: 'POST', json: payload });
      }
      push(provider ? '模型已更新' : '模型已添加');
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
      title={provider ? '编辑全局模型' : '添加全局模型'}
      description="兼容 OpenAI Chat Completions 接口。Base URL 填写到 /v1 即可。"
      width="620px"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">显示名称</label>
            <input className="field" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 GPT-4.1" />
          </div>
          <div>
            <label className="label">模型 ID</label>
            <input className="field" required maxLength={128} value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="gpt-4.1" />
          </div>
        </div>
        <div>
          <label className="label">Base URL</label>
          <input className="field" required maxLength={512} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
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
            <input className="field" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </div>
          <div>
            <label className="label">最大输出 Token（可选）</label>
            <input className="field" type="number" min={1} max={64000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[12.5px] text-white/60">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-emerald-400" />
            启用此模型
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-white/60">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="accent-emerald-400" />
            标记为全局默认
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
