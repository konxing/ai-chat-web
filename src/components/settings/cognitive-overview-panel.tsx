'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { Alert } from '@/components/ui';
import type { OverviewSection, OverviewSectionKey } from '@/lib/cognitive/overview';
import { COGNITIVE_DETAIL_TABS, settingsHref, type CognitiveDetailTab } from './settings-tabs';

const OVERVIEW_TARGETS: Record<OverviewSectionKey, CognitiveDetailTab> = {
  graph: 'memoryGraph',
  timeline: 'timeline',
  reflections: 'reflections',
  decisions: 'decisions',
  profile: 'userModel',
  memory: 'memory',
  policy: 'policy'
};

const ENTRY_HINTS: Record<CognitiveDetailTab, string> = {
  memory: '查看、编辑和删除已保存的记忆',
  policy: '设置记忆范围、检索数量和保留时长',
  timeline: '查看记忆的历史变化',
  memoryGraph: '浏览记忆之间的关联',
  decisions: '回顾做过的选择和后续结果',
  reflections: '查看洞察、审核结果和生成频率',
  userModel: '管理个人特征、偏好和待确认的画像项',
  wiki: '按主题整理和浏览已有知识',
  experience: '记录和回顾有来源的实践经验'
};

const OVERVIEW_URL = '/api/account/cognitive/overview';

interface OverviewPayload {
  sections: OverviewSection[];
  preferencesUnavailable: boolean;
}

export function CognitiveOverviewPanel({ onOpen }: { onOpen: (tab: CognitiveDetailTab) => void }) {
  const [payload, setPayload] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await apiFetch<OverviewPayload>(OVERVIEW_URL));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = new Map(payload?.sections.map((section) => [OVERVIEW_TARGETS[section.key], section]));

  return (
    <section className="panel p-4 sm:p-6" aria-labelledby="cognitive-records-title">
      <h2 id="cognitive-records-title" className="text-[16px] font-semibold text-white">记录与详细设置</h2>
      {error ? (
        <Alert tone="error" className="mt-4">
          记录统计加载失败。{error}
          <button type="button" className="btn-ghost ml-2" onClick={() => void load()}>重试</button>
        </Alert>
      ) : null}
      {payload?.preferencesUnavailable ? (
        <Alert tone="info" className="mt-4">
          暂时读不到部分模块状态，相关统计会在状态恢复后显示。
        </Alert>
      ) : null}

      <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-busy={loading}>
        {COGNITIVE_DETAIL_TABS.map(([tab, label, Icon]) => {
          const section = sections.get(tab);
          return (
            <li key={tab} className="min-w-0">
              <Link
                href={settingsHref(tab)}
                prefetch={false}
                onNavigate={(event) => {
                  event.preventDefault();
                  onOpen(tab);
                }}
                className="flex h-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 transition hover:border-aurora-400/30 hover:bg-aurora-400/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-aurora-400"
              >
                <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-aurora-300" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-white">{label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">{ENTRY_HINTS[tab]}</span>
                  {section && (section.enabled || !payload?.preferencesUnavailable) ? (
                    <span className="mt-1 block text-xs leading-relaxed text-slate-400">{section.detail}</span>
                  ) : null}
                </span>
                <ChevronRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
