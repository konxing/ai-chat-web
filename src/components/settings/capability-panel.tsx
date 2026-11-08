'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';

interface Dimension { id: string; title: string; key: string; goal: string | null; enabled: boolean }
interface Evidence { id: string; note: string; kind: string; score: number | null; observedAt: string }
interface Analysis {
  sampleCount: number; evidenceCount: number; estimate: number | null;
  confidence: number; trend: number | null; insufficientEvidence: boolean; disclaimer: string
}
interface Intervention {
  id: string; suggestion: string; status: string; effectiveness: number | null;
  feedback: string | null; createdAt: string
}
const root = '/api/account/cognitive/capabilities';
const url = (id: string) => root + '/' + encodeURIComponent(id);

export function CapabilityPanel() {
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [selected, setSelected] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [note, setNote] = useState('');
  const [score, setScore] = useState('');
  const [kind, setKind] = useState<'TASK_RESULT' | 'SELF_REPORT'>('TASK_RESULT');
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const loadDimensions = useCallback(async () => {
    const data = await apiFetch<{ dimensions: Dimension[] }>(root);
    setDimensions(data.dimensions);
    setSelected((current) => data.dimensions.some((d) => d.id === current)
      ? current : (data.dimensions[0]?.id ?? ''));
  }, []);

  const loadDetails = useCallback(async (id: string) => {
    const [e, a, i] = await Promise.all([
      apiFetch<{ evidence: Evidence[] }>(url(id) + '/evidence'),
      apiFetch<{ analysis: Analysis }>(url(id) + '/analysis'),
      apiFetch<{ interventions: Intervention[] }>(url(id) + '/interventions')
    ]);
    setEvidence(e.evidence);
    setAnalysis(a.analysis);
    setInterventions(i.interventions);
  }, []);

  useEffect(() => {
    void loadDimensions().catch((error) => setMessage(errorMessage(error)));
  }, [loadDimensions]);
  useEffect(() => {
    if (!selected) {
      setEvidence([]); setAnalysis(null); setInterventions([]);
      return;
    }
    void loadDetails(selected).catch((error) => setMessage(errorMessage(error)));
  }, [selected, loadDetails]);

  async function execute(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await task(); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function addDimension() {
    await execute(async () => {
      const name = title.trim();
      if (!name) { setMessage('请输入能力名称'); return; }
      // Opaque per-user key; the visible title remains AES-encrypted on the server.
      const key = 'cap_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
      const result = await apiFetch<{ dimension: Dimension }>(root, {
        method: 'POST', json: { key, title: name, goal: goal.trim() || null }
      });
      setTitle(''); setGoal('');
      await loadDimensions();
      setSelected(result.dimension.id);
      setMessage('能力维度已建立');
    });
  }

  async function addEvidence() {
    if (!selected) return;
    await execute(async () => {
      const value = score.trim() ? Number(score) / 100 : null;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
        setMessage('分数须在 0–100 之间'); return;
      }
      await apiFetch(url(selected) + '/evidence', {
        method: 'POST', json: { kind, note: note.trim(), score: kind === 'TASK_RESULT' ? value : null }
      });
      setNote(''); setScore('');
      await loadDetails(selected);
      setMessage('已保存证据');
    });
  }

  async function suggest() {
    if (!selected) return;
    await execute(async () => {
      await apiFetch(url(selected) + '/suggest', { method: 'POST' });
      await loadDetails(selected);
      setMessage('训练建议已生成；不会自动执行');
    });
  }

  async function changeStatus(item: Intervention, status: 'ACCEPTED' | 'SKIPPED' | 'COMPLETED') {
    await execute(async () => {
      const ratingText = ratings[item.id] ?? '';
      const effectiveness = status === 'COMPLETED' && ratingText !== ''
        ? Number(ratingText) / 100 : null;
      if (effectiveness !== null && (!Number.isFinite(effectiveness) || effectiveness < 0 || effectiveness > 1)) {
        setMessage('效果评分须在 0–100 之间'); return;
      }
      await apiFetch(url(selected) + '/interventions/' + encodeURIComponent(item.id), {
        method: 'PATCH', json: {
          status, ...(status === 'COMPLETED' ? {
            effectiveness, feedback: feedback[item.id]?.trim() || null
          } : {})
        }
      });
      await loadDetails(selected);
      setMessage('反馈已更新');
    });
  }

  const current = dimensions.find((item) => item.id === selected);
  return (
    <section className="panel space-y-5 p-5 sm:p-6">
      <div>
        <h2 className="text-[17px] font-semibold text-white">个人能力成长</h2>
        <p className="mt-1 text-sm text-white/50">
          仅使用你主动录入的证据。能力估计不是人格、智力或医疗评估；不自动分析全部聊天内容。
        </p>
      </div>
      {message ? <p role="status" className="rounded-lg bg-white/[0.07] p-3 text-sm text-white/80">{message}</p> : null}

      <div className="space-y-2 rounded-xl border border-white/10 p-4">
        <h3 className="text-sm font-medium text-white">建立能力维度</h3>
        <input aria-label="能力名称" className="input" placeholder="例如：问题分解能力"
          value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
        <input aria-label="长期目标" className="input" placeholder="希望达到的目标（可选）"
          value={goal} maxLength={1000} onChange={(e) => setGoal(e.target.value)} />
        <button type="button" disabled={busy || !title.trim()} className="btn-primary"
          onClick={() => void addDimension()}>新增能力</button>
      </div>

      {dimensions.length ? (
        <>
          <label className="block space-y-2 text-sm text-white/70">
            <span>选择能力</span>
            <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {dimensions.map((d) => <option key={d.id} value={d.id}>{d.title}{d.enabled ? '' : '（已暂停）'}</option>)}
            </select>
          </label>
          {current ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-white/50">{current.goal || '尚未填写目标'}</span>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void execute(async () => {
                await apiFetch(url(selected), { method: 'PATCH', json: { enabled: !current.enabled } });
                await loadDimensions();
              })}>{current.enabled ? '暂停该能力' : '恢复该能力'}</button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => {
                if (!window.confirm('确定永久删除这个能力维度及其全部证据、快照和训练记录？')) return;
                void execute(async () => {
                  await apiFetch(url(selected), { method: 'DELETE' });
                  await loadDimensions();
                });
              }}>删除能力及全部记录</button>
            </div>
          ) : null}

          <div className="rounded-xl border border-white/10 p-4 space-y-3">
            <h3 className="text-sm font-medium text-white">主动记录观察证据</h3>
            <select className="input" value={kind}
              onChange={(e) => setKind(e.target.value as 'TASK_RESULT' | 'SELF_REPORT')}>
              <option value="TASK_RESULT">可量化的任务结果</option>
              <option value="SELF_REPORT">个人观察（不计入评分）</option>
            </select>
            {kind === 'TASK_RESULT' ? (
              <input className="input" type="number" min={0} max={100} step={1}
                placeholder="任务表现分数 0–100（可留空）" aria-label="任务表现分数"
                value={score} onChange={(e) => setScore(e.target.value)} />
            ) : null}
            <textarea className="input min-h-20" maxLength={2000} aria-label="证据内容"
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="具体任务是什么、如何评价、观察到了什么" />
            <button type="button" className="btn-primary" disabled={busy || !note.trim() || !current?.enabled}
              onClick={() => void addEvidence()}>保存证据</button>
          </div>

          <div className="rounded-xl border border-white/10 p-4 space-y-2">
            <h3 className="text-sm font-medium text-white">能力分析</h3>
            {analysis ? (
              <p className="text-sm text-white/70">
                {analysis.insufficientEvidence
                  ? `证据不足：目前有 ${analysis.sampleCount} 条有效任务分数，至少需要 3 条。`
                  : `按已记录任务平均表现：${Math.round((analysis.estimate ?? 0) * 100)} / 100；有效样本 ${analysis.sampleCount} 条。`}
                {analysis.trend !== null ? ` 后半段相对前半段的平均变化：${Math.round(analysis.trend * 100)} 分。` : ''}
              </p>
            ) : <p className="text-sm text-white/50">尚无分析结果</p>}
            <button type="button" className="btn-ghost" disabled={busy || !current?.enabled}
              onClick={() => void execute(async () => {
                await apiFetch(url(selected) + '/analysis', { method: 'POST' });
                await loadDetails(selected);
                setMessage('已保存能力状态快照');
              })}>记录本次能力快照</button>
            <p className="text-xs text-white/40">分数只表示你录入的任务评价，不代表客观能力值。</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-white">最近证据</h3>
            {evidence.slice(0, 12).map((item) => (
              <div key={item.id} className="rounded-lg border border-white/10 p-3 text-sm text-white/75">
                <p>{item.note}</p>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-white/40">
                  <span>{item.observedAt.slice(0, 10)} · {item.kind === 'TASK_RESULT' ? '任务' : '观察'}
                    {item.score !== null ? ` · ${Math.round(item.score * 100)} 分` : ''}</span>
                  <button disabled={busy} type="button" className="underline" onClick={() => {
                    if (!window.confirm('删除这条证据？关联的旧快照也会清理。')) return;
                    void execute(async () => {
                      await apiFetch(url(selected) + '/evidence/' + encodeURIComponent(item.id), { method: 'DELETE' });
                      await loadDetails(selected);
                    });
                  }}>删除</button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3 rounded-xl border border-white/10 p-4">
            <h3 className="text-sm font-medium text-white">练习建议与反馈</h3>
            <p className="text-xs text-white/50">
              只有点击生成按钮时，才会向已配置的 AI 服务发送本能力最近的少量证据与历史反馈。
            </p>
            <button type="button" className="btn-primary"
              disabled={busy || !current?.enabled || !!analysis?.insufficientEvidence}
              onClick={() => void suggest()}>{busy ? '处理中…' : 'AI 生成一项练习建议'}</button>
            {interventions.map((item) => (
              <article key={item.id} className="space-y-2 rounded-lg bg-white/[0.04] p-3">
                <p className="whitespace-pre-wrap text-sm text-white/80">{item.suggestion}</p>
                <p className="text-xs text-white/40">状态：{item.status} · {item.createdAt.slice(0, 10)}</p>
                {item.status === 'PROPOSED' ? (
                  <div className="flex gap-2">
                    <button className="btn-ghost" disabled={busy} onClick={() => void changeStatus(item, 'ACCEPTED')}>采纳</button>
                    <button className="btn-ghost" disabled={busy} onClick={() => void changeStatus(item, 'SKIPPED')}>不采纳</button>
                  </div>
                ) : null}
                {item.status === 'ACCEPTED' ? (
                  <div className="space-y-2">
                    <textarea className="input min-h-16" maxLength={2000}
                      placeholder="执行后的效果与复盘（可选）" value={feedback[item.id] ?? ''}
                      onChange={(e) => setFeedback((old) => ({ ...old, [item.id]: e.target.value }))} />
                    <input className="input" type="number" min={0} max={100}
                      placeholder="自评效果 0–100（可选）" value={ratings[item.id] ?? ''}
                      onChange={(e) => setRatings((old) => ({ ...old, [item.id]: e.target.value }))} />
                    <div className="flex gap-2">
                      <button className="btn-primary" disabled={busy} onClick={() => void changeStatus(item, 'COMPLETED')}>完成并记录反馈</button>
                      <button className="btn-ghost" disabled={busy} onClick={() => void changeStatus(item, 'SKIPPED')}>终止</button>
                    </div>
                  </div>
                ) : null}
                {item.status === 'COMPLETED' ? (
                  <p className="text-sm text-white/60">
                    {item.feedback || '已完成'}{item.effectiveness !== null
                      ? ` · 自评效果 ${Math.round(item.effectiveness * 100)} 分` : ''}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : <p className="text-sm text-white/50">还没有能力维度。可先建立一项，然后手动记录练习结果。</p>}
    </section>
  );
}
