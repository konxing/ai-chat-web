'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';

interface Page { id: string; topicKey: string; title: string; status: string; version: number; updatedAt: string }
interface Detail extends Page { sources: { id: string; content: string; type: string; origin: string }[] }
const base = '/api/account/cognitive/wiki';
export function WikiPanel() {
  const [pages, setPages] = useState<Page[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    const data = await apiFetch<{ pages: Page[] }>(base);
    setPages(data.pages);
    setSelected((id) => data.pages.some((p) => p.id === id) ? id : data.pages[0]?.id ?? '');
  }, []);
  const read = useCallback(async (id: string) => {
    const data = await apiFetch<{ page: Detail }>(base + '/' + encodeURIComponent(id));
    setDetail(data.page);
  }, []);
  useEffect(() => { void refresh().catch((e) => setNotice(errorMessage(e))); }, [refresh]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    void read(selected).catch((e) => setNotice(errorMessage(e)));
  }, [selected, read]);
  async function act(callback: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await callback(); } catch (e) { setNotice(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel space-y-4 p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-white">个人主题知识库</h2>
      <p className="text-sm text-white/50">
        仅将你已有的记忆组织成来源索引，原文随记忆删除而失效。草稿必须由你确认后才参与对话检索。
      </p>
      {notice ? <p role="status" className="rounded-lg bg-white/5 p-3 text-sm text-white/80">{notice}</p> : null}
      <button className="btn-primary" disabled={busy} type="button" onClick={() => void act(async () => {
        const result = await apiFetch<{ drafts: number }>(base + '/build', { method: 'POST' });
        await refresh();
        setNotice(`整理完毕，检查了 ${result.drafts} 个主题草稿。需要开启长期记忆和用户画像。`);
      })}>从现有记忆构建主题草稿</button>
      {pages.length ? (
        <>
          <select aria-label="选择知识页面" className="input" value={selected}
            onChange={(e) => setSelected(e.target.value)}>
            {pages.map((p) => <option key={p.id} value={p.id}>
              {p.title} · {p.status === 'CONFIRMED' ? '已确认' : '待确认'}
            </option>)}
          </select>
          {detail ? (
            <div className="space-y-3 rounded-xl border border-white/10 p-4">
              <h3 className="font-medium text-white">{detail.title}</h3>
              <p className="text-xs text-white/50">版本 {detail.version} · 来源 {detail.sources.length} 条</p>
              {detail.sources.map((source) => (
                <div key={source.id} className="rounded-lg bg-white/[0.04] p-3 text-sm text-white/80">
                  <p className="whitespace-pre-wrap">{source.content}</p>
                  <p className="mt-1 text-xs text-white/40">{source.type} · {source.origin} · 记忆 {source.id.slice(0, 8)}</p>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                {detail.status === 'DRAFT' ? (
                  <button type="button" className="btn-primary" disabled={busy || !detail.sources.length}
                    onClick={() => void act(async () => {
                      await apiFetch(base + '/' + encodeURIComponent(detail.id), {
                        method: 'PATCH', json: { action: 'CONFIRM', version: detail.version }
                      });
                      await refresh(); await read(detail.id);
                      setNotice('已确认。此页面可在相关提问中参与检索。');
                    })}>确认页面并允许检索</button>
                ) : null}
                <button type="button" className="btn-ghost" disabled={busy}
                  onClick={() => {
                    if (!window.confirm('确定删除该主题索引？不会删除原始记忆。')) return;
                    void act(async () => {
                      await apiFetch(base + '/' + encodeURIComponent(detail.id), { method: 'DELETE' });
                      await refresh(); setDetail(null);
                    });
                  }}>删除知识页面</button>
              </div>
            </div>
          ) : null}
        </>
      ) : <p className="text-sm text-white/50">目前没有主题知识页面。请先建立长期记忆，然后生成草稿。</p>}
    </section>
  );
}
