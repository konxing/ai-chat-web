'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import type { CognitivePreferences } from '@/lib/cognitive/preferences';
import { Alert } from '@/components/ui';
import { CognitiveOverviewPanel } from './cognitive-overview-panel';
import type { CognitiveDetailTab } from './settings-tabs';

const PREFERENCES_URL = '/api/account/cognitive';

const GROUPS = [
  {
    label: '长期记忆',
    options: [
      ['memoryEnabled', '使用长期记忆', '在对话中使用已保存的记忆，并根据策略记住新内容。'],
      ['memoryWritePaused', '暂停记入新内容', '暂停写入，已保存的记忆仍可用于对话。']
    ]
  },
  {
    label: '记忆策略与视图',
    options: [
      ['emotionEnabled', '情绪类记忆', '允许在记忆策略授权的情境中记录和使用这类内容。'],
      ['adaptiveMemoryEnabled', '自动收紧记忆策略', '在多次拒绝或删除同类记忆后，改为先问再记。'],
      ['associationEnabled', '记忆网络', '查看记忆之间有哪些联系。'],
      ['timelineEnabled', '认知时间线', '按时间查看记忆如何变化。']
    ]
  },
  {
    label: '画像与洞察',
    options: [
      ['userModelEnabled', '用户画像', '整理和使用你确认的个人特点与偏好。'],
      ['decisionMemoryEnabled', '决策记录', '记录你做过的选择及后续结果。'],
      ['reflectionEnabled', 'AI 主动洞察', '根据已保存的记忆提出供你查看的洞察。']
    ]
  }
] as const;

type Preference = (typeof GROUPS)[number]['options'][number][0];
type PreferenceResponse = { preferences: CognitivePreferences };

export function CognitiveSettingsPanel({ onOpen }: { onOpen: (tab: CognitiveDetailTab) => void }) {
  const [preferences, setPreferences] = useState<CognitivePreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Preference | null>(null);
  const [error, setError] = useState('');
  const [overviewVersion, setOverviewVersion] = useState(0);

  const loadPreferences = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<PreferenceResponse>(PREFERENCES_URL, { signal });
      setPreferences(data.preferences);
    } catch (err) {
      if (!signal?.aborted) setError(errorMessage(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadPreferences(controller.signal);
    return () => controller.abort();
  }, [loadPreferences]);

  async function changePreference(key: Preference, value: boolean) {
    setSaving(key);
    setError('');
    try {
      const data = await apiFetch<PreferenceResponse>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { [key]: value }
      });
      setPreferences(data.preferences);
      setOverviewVersion((current) => current + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <section className="panel p-4 sm:p-6" aria-labelledby="personal-intelligence-title">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-aurora-400/20 bg-aurora-400/10 text-aurora-300">
            <Brain aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 id="personal-intelligence-title" className="text-xl font-semibold text-white">个人智能层</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-300">
              在这里选择 AI 可以使用的个人信息，并查看相关记录和设置。
            </p>
          </div>
        </div>

        {error ? (
          <Alert tone="error" className="mt-4">
            {preferences ? '设置保存失败' : '设置读取失败'}。{error}
            {!preferences ? (
              <button type="button" className="btn-ghost ml-2" onClick={() => void loadPreferences()}>重试</button>
            ) : null}
          </Alert>
        ) : null}

        <div className="mt-5 space-y-4" aria-busy={loading || saving !== null}>
          {GROUPS.map(({ label, options }) => (
            <fieldset key={label} className="min-w-0 rounded-xl border border-white/10 bg-white/[0.02] px-3 pb-1 sm:px-4">
              <legend className="px-1.5 text-sm font-medium text-white">{label}</legend>
              <div className="divide-y divide-white/10 sm:grid sm:grid-cols-2 sm:divide-y-0 sm:gap-x-4">
                {options.map(([key, name, description]) => {
                  const requiresMemory = key === 'memoryWritePaused' || key === 'associationEnabled' || key === 'timelineEnabled';
                  const memoryOff = requiresMemory && preferences?.memoryEnabled === false;
                  const on = preferences?.[key] === true;
                  return (
                    <label key={key} className="flex min-h-[64px] min-w-0 cursor-pointer items-start gap-3 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-white">{name}</span>
                        <span id={`preference-${key}-hint`} className="mt-1 block text-xs leading-relaxed text-slate-400">
                          {description}{memoryOff ? ' 开启长期记忆后生效。' : null}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-center pt-0.5">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={name}
                          aria-describedby={`preference-${key}-hint`}
                          checked={on}
                          disabled={!preferences || saving !== null}
                          onChange={(event) => void changePreference(key, event.target.checked)}
                          className="peer sr-only"
                        />
                        <span aria-hidden="true" className="relative h-5 w-9 rounded-full border border-slate-500 bg-slate-700 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3.5 after:w-3.5 after:rounded-full after:bg-white after:transition-transform peer-checked:border-aurora-400 peer-checked:bg-aurora-600 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-aurora-300 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#111720] peer-disabled:opacity-60" />
                        <span role="status" className="mt-1 text-center text-[10px] leading-4 text-slate-400">
                          {loading ? '读取中' : !preferences ? '未知' : saving === key ? '保存中' : on ? '已开启' : '已关闭'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </section>
      <CognitiveOverviewPanel key={overviewVersion} onOpen={onOpen} />
    </>
  );
}
