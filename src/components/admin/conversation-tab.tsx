'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { useToast } from '@/components/ui';
import { useReauth } from '@/components/ui';
import { LoadingBlock } from '@/components/ui';

interface PromptVersion {
  id: string;
  version: number;
  content: string;
  status: string;
  evaluationScore: number | null;
  createdAt: string;
}

/** OWNER「对话智能设置」：总开关 + Prompt 版本管理（候选/激活/回滚）+ Inspector。 */
export function ConversationTab() {
  const { push } = useToast();
  const { requestPassword } = useReauth();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [candidate, setCandidate] = useState('');
  const [busy, setBusy] = useState(false);
  const [engineVersion, setEngineVersion] = useState<'legacy' | 'dialogue-v2'>('legacy');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ enabled: boolean; engineVersion: 'legacy' | 'dialogue-v2'; versions: PromptVersion[]; activeVersion: number | null }>(
        '/api/admin/conversation'
      );
      setEnabled(data.enabled);
      setEngineVersion(data.engineVersion ?? 'legacy');
      setVersions(data.versions);
      setActiveVersion(data.activeVersion);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { void load(); }, [load]);

  async function setEngine(version: 'legacy' | 'dialogue-v2') {
    const password = await requestPassword('切换对话引擎版本需要验证管理员身份。');
    if (!password) return;
    setBusy(true);
    try {
      const data = await apiFetch<{ engineVersion: 'legacy' | 'dialogue-v2' }>('/api/admin/conversation', {
        method: 'PATCH',
        json: { engineVersion: version, confirmPassword: password }
      });
      setEngineVersion(data.engineVersion);
      push(`引擎已切换为 ${data.engineVersion}`);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    const password = await requestPassword('修改对话智能开关需要验证管理员身份。');
    if (!password) return;
    setBusy(true);
    try {
      const data = await apiFetch<{ enabled: boolean }>('/api/admin/conversation', {
        method: 'PATCH',
        json: { enabled: !enabled, confirmPassword: password }
      });
      setEnabled(data.enabled);
      push(data.enabled ? '对话智能层已开启' : '对话智能层已关闭');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addCandidate() {
    const password = await requestPassword('新增候选提示词需要验证管理员身份。');
    if (!password || !candidate.trim()) return;
    setBusy(true);
    try {
      await apiFetch('/api/admin/conversation', {
        method: 'POST',
        json: { action: 'candidate', content: candidate, confirmPassword: password }
      });
      setCandidate('');
      push('候选版本已创建（未生效，须评测后激活）');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    const password = await requestPassword('激活/回滚提示词版本需要验证管理员身份。');
    if (!password) return;
    setBusy(true);
    try {
      await apiFetch('/api/admin/conversation', {
        method: 'POST',
        json: { action: 'activate', id, confirmPassword: password }
      });
      push('版本已激活');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingBlock label="加载对话智能设置" />;

  return (
    <div className="space-y-5">
      <section className="panel p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-white">对话智能层</h2>
        <p className="mt-1 text-[12.5px] text-white/40">
          动态交流模式 + 回答策略 + 自然表达 + 知识融合 + 表达偏好学习。默认关；对本身已自然的强模型增益有限，
          对模板化重的模型更有价值。开启不增加默认模型调用。
        </p>
        <label className="mt-4 flex items-start justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
          <div>
            <div className="text-[13px] font-medium text-white/80">启用对话智能层</div>
            <div className="mt-0.5 text-[11.5px] text-white/35">当前：{enabled ? '开' : '关'}；生效提示词版本：{activeVersion ?? '默认'}</div>
          </div>
          <input
            type="checkbox"
            className="mt-1 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-white/10 transition checked:bg-emerald-400/80 relative before:absolute before:top-0.5 before:left-0.5 before:h-4 before:w-4 before:rounded-full before:bg-white before:transition checked:before:translate-x-4"
            checked={enabled}
            disabled={busy}
            onChange={() => void toggle()}
          />
        </label>
        <div className="mt-4">
          <label className="label">引擎版本（灰度/回滚）</label>
          <select
            className="field"
            value={engineVersion}
            disabled={busy}
            onChange={(e) => void setEngine(e.target.value as 'legacy' | 'dialogue-v2')}
          >
            <option value="legacy">legacy（旧规则累加，默认）</option>
            <option value="dialogue-v2">dialogue-v2（话语行为/状态/回应动作）</option>
          </select>
          <p className="mt-1.5 text-[11.5px] text-white/35">
            默认 legacy；dialogue-v2 需经 A/B 验证非劣后再灰度。按用户覆盖键 conversationEngineVersionUser:&lt;userId&gt; 可小范围开启。回滚=切回 legacy。
          </p>
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-white">提示词版本（可回滚）</h2>
        <p className="mt-1 text-[12.5px] text-white/40">更新不覆盖历史；候选须评测后才能激活；激活旧版本即回滚。</p>
        <div className="mt-4 space-y-2">
          {versions.length === 0 ? <p className="text-[12.5px] text-white/35">暂无版本，使用内置默认策略。</p> : null}
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] px-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] text-white/80">v{v.version} · {v.status}{v.evaluationScore !== null ? ` · 评分 ${v.evaluationScore}` : ''}</div>
                <div className="truncate text-[11.5px] text-white/35">{v.content.slice(0, 60)}</div>
              </div>
              {v.status !== 'active' ? (
                <button type="button" className="btn-ghost shrink-0" disabled={busy} onClick={() => void activate(v.id)}>激活</button>
              ) : (
                <span className="shrink-0 text-[11.5px] text-emerald-300/70">生效中</span>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4">
          <label className="label">新增候选提示词</label>
          <textarea className="field min-h-[80px] resize-y" value={candidate} onChange={(e) => setCandidate(e.target.value)} placeholder="候选全局交流原则文本（须评测后激活）" />
          <button type="button" className="btn-primary mt-2" disabled={busy || !candidate.trim()} onClick={() => void addCandidate()}>创建候选</button>
        </div>
      </section>
    </div>
  );
}
