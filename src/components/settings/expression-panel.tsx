'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { CHAT_PERSONA_IDS, CHAT_PERSONAS, type ChatPersona } from '@/lib/chat-personas';
import { useToast, LoadingBlock } from '@/components/ui';

interface Style {
  persona?: ChatPersona;
  knowledgeDepth: string;
  naturalness: string;
  structure: string;
  proactivity: string;
  restraint: string;
  length: string;
  factuality: string;
}

const OPTIONS: Array<{ key: keyof Style; label: string; choices: Array<[string, string]> }> = [
  { key: 'knowledgeDepth', label: '知识深度', choices: [['low', '浅'], ['medium', '中'], ['high', '高']] },
  { key: 'length', label: '回答长度', choices: [['short', '短'], ['dynamic', '动态'], ['long', '长']] },
  { key: 'structure', label: '结构化', choices: [['minimal', '少分点'], ['dynamic', '动态'], ['rich', '多结构']] },
  { key: 'proactivity', label: '主动思考', choices: [['low', '低'], ['medium', '中'], ['high', '高']] },
  { key: 'restraint', label: '表达克制', choices: [['low', '低'], ['medium', '中'], ['high', '高']] }
];

/** 普通用户查看/修改自己的表达偏好（只影响表达，不影响事实/安全）。 */
export function ExpressionPanel() {
  const { push } = useToast();
  const [loading, setLoading] = useState(true);
  const [style, setStyle] = useState<Style | null>(null);
  const [meta, setMeta] = useState<{ updatedAt: string | null; source: string | null }>({ updatedAt: null, source: null });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ style: Style; meta: { updatedAt: string | null; source: string | null } }>('/api/account/conversation-style');
      setStyle(data.style);
      setMeta(data.meta ?? { updatedAt: null, source: null });
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { void load(); }, [load]);

  async function reset() {
    setBusy(true);
    try {
      const data = await apiFetch<{ style: Style }>('/api/account/conversation-style', { method: 'DELETE' });
      setStyle(data.style);
      setMeta({ updatedAt: null, source: null });
      push('已恢复默认表达偏好');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function set(key: keyof Style, value: string) {
    if (!style) return;
    setBusy(true);
    try {
      const data = await apiFetch<{ style: Style }>('/api/account/conversation-style', {
        method: 'PUT',
        json: { [key]: value }
      });
      setStyle(data.style);
      push('表达偏好已保存');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingBlock label="加载表达偏好" />;
  if (!style) return null;

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="text-[15px] font-semibold text-white">表达偏好</h2>
      <p className="mt-1 text-[12.5px] text-white/40">
        只调整回答的表达方式，不影响事实正确性与安全规则。也可以在对话里直接说"以后不要列点/深入一点"，系统会学习。
      </p>
      <div className="mt-2 flex items-center gap-3 text-[11.5px] text-white/35">
        <span>来源：{meta.source ?? '默认'}</span>
        <span>最近修改：{meta.updatedAt ? meta.updatedAt.slice(0, 10) : '—'}</span>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void reset()}>恢复默认</button>
      </div>
      <div className="mt-4 space-y-4">
        <div>
          <div className="label">聊天人格</div>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {CHAT_PERSONA_IDS.map((id) => (
              <button
                key={id}
                type="button"
                disabled={busy}
                aria-pressed={(style.persona ?? 'default') === id}
                onClick={() => void set('persona', id)}
                className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left hover:bg-white/[0.08] aria-pressed:border-emerald-400/60 aria-pressed:bg-emerald-400/15"
              >
                <span className="block text-sm font-medium text-white">{CHAT_PERSONAS[id].name}</span>
                <span className="mt-1 block text-xs text-white/65">{CHAT_PERSONAS[id].description}</span>
              </button>
            ))}
          </div>
        </div>
        {OPTIONS.map((opt) => (
          <div key={opt.key}>
            <div className="label">{opt.label}</div>
            <div className="mt-1 flex gap-2">
              {opt.choices.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => void set(opt.key, value)}
                  className={
                    style[opt.key] === value
                      ? 'rounded-lg bg-emerald-400/20 px-3 py-1.5 text-[12.5px] text-emerald-200'
                      : 'rounded-lg bg-white/[0.04] px-3 py-1.5 text-[12.5px] text-white/50 hover:bg-white/[0.08]'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
