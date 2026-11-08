'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { useToast, LoadingBlock } from '@/components/ui';

interface Style {
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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ style: Style }>('/api/account/conversation-style');
      setStyle(data.style);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { void load(); }, [load]);

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
      <div className="mt-4 space-y-4">
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
