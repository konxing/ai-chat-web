'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';

interface Source { id: string; title: string; type: 'MEMORY' | 'INTERVENTION' }
interface Experience {
  id: string; title: string; lesson: string; validation: string | null;
  sourceMemoryId: string | null; sourceInterventionId: string | null;
  status: string; version: number; updatedAt: string
}
const base = '/api/account/cognitive/experience';
export function ExperiencePanel() {
  const [sources, setSources] = useState<Source[]>([]);
  const [items, setItems] = useState<Experience[]>([]);
  const [sourceKey, setSourceKey] = useState('');
  const [title, setTitle] = useState('');
  const [lesson, setLesson] = useState('');
  const [validation, setValidation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    const [s, i] = await Promise.all([
      apiFetch<{ sources: Source[] }>(base + '/sources'),
      apiFetch<{ experiences: Experience[] }>(base)
    ]);
    setSources(s.sources); setItems(i.experiences);
    setSourceKey((current) => s.sources.some((entry) => entry.type + ':' + entry.id === current)
      ? current : s.sources[0] ? s.sources[0].type + ':' + s.sources[0].id : '');
  }, []);
  useEffect(() => { void load().catch((e) => setNotice(errorMessage(e))); }, [load]);
  async function act(callback: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await callback(); } catch (e) { setNotice(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function create() {
    const [sourceType, sourceId] = sourceKey.split(':');
    if (!sourceId) { setNotice('请先选择来源'); return; }
    await act(async () => {
      await apiFetch(base, {
        method: 'POST', json: {
          ...(sourceType === 'MEMORY' ? { memoryId: sourceId } : { interventionId: sourceId }),
          title: title.trim(), lesson: lesson.trim(), validation: validation.trim() || null
        }
      });
      setTitle(''); setLesson(''); setValidation('');
      await load(); setNotice('草稿已保存，可在核对验证依据后确认');
    });
  }
  async function update(item: Experience, action: 'VERIFY' | 'REFUTE') {
    await act(async () => {
      await apiFetch(base + '/' + encodeURIComponent(item.id), {
        method: 'PATCH', json: { action, version: item.version }
      });
      await load();
      setNotice(action === 'VERIFY' ? '已确认，相关提问可引用这项经验' : '已标记为不可使用');
    });
  }
  return (
    <section className="panel space-y-5 p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-white">实践经验库</h2>
      <p className="text-sm text-white/50">
        经验必须关联一条原始记忆或已完成的训练记录。AI 不会自动把未经核验的想法当成经验。
        删除来源时，对应经验也会删除。
      </p>
      {notice ? <p role="status" className="rounded-lg bg-white/5 p-3 text-sm text-white/80">{notice}</p> : null}
      <div className="space-y-3 rounded-xl border border-white/10 p-4">
        <h3 className="text-sm font-semibold text-white">记录一次有来源的经验</h3>
        <select className="input" aria-label="选择来源记录" value={sourceKey}
          onChange={(e) => setSourceKey(e.target.value)}>
          {sources.map((source) => (
            <option key={source.type + source.id} value={source.type + ':' + source.id}>
              {source.type === 'MEMORY' ? '记忆' : '已完成训练'} · {source.title}
            </option>
          ))}
        </select>
        <input className="input" aria-label="经验主题" maxLength={160}
          placeholder="发现了什么问题？" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input min-h-20" aria-label="经验和方法" maxLength={2000}
          placeholder="具体如何处理？适用条件是什么？" value={lesson}
          onChange={(e) => setLesson(e.target.value)} />
        <textarea className="input min-h-16" aria-label="验证证据" maxLength={1200}
          placeholder="如何验证？有哪些日志、复现结果或实际效果？确认前必须提供。"
          value={validation} onChange={(e) => setValidation(e.target.value)} />
        <button type="button" className="btn-primary" disabled={busy || !sourceKey || !title.trim() || !lesson.trim()}
          onClick={() => void create()}>保存草稿</button>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-white">历史经验</h3>
        {items.map((item) => (
          <div key={item.id} className="space-y-2 rounded-xl border border-white/10 p-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-white">{item.title}</h4>
              <span className="text-xs text-white/50">
                {item.status === 'DRAFT' ? '待验证' : item.status === 'VERIFIED' ? '用户已确认' : '已证伪'}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-white/75">{item.lesson}</p>
            <p className="whitespace-pre-wrap text-xs text-white/50">验证依据：{item.validation || '尚未填写'}</p>
            <div className="flex flex-wrap gap-2">
              {item.status === 'DRAFT' ? (
                <button type="button" className="btn-primary" disabled={busy || !item.validation}
                  onClick={() => void update(item, 'VERIFY')}>确认经验</button>
              ) : null}
              {item.status !== 'REFUTED' ? (
                <button type="button" className="btn-ghost" disabled={busy}
                  onClick={() => void update(item, 'REFUTE')}>标记失效</button>
              ) : null}
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => {
                if (!window.confirm('确定删除这条经验？')) return;
                void act(async () => {
                  await apiFetch(base + '/' + encodeURIComponent(item.id), { method: 'DELETE' });
                  await load();
                });
              }}>删除</button>
            </div>
          </div>
        ))}
        {!items.length ? <p className="text-sm text-white/50">还没有经验记录。</p> : null}
      </div>
    </section>
  );
}
