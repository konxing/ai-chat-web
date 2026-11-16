'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Smile } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import {
  PERSONAL_STICKER_LABEL_LIMIT,
  PERSONAL_STICKER_MAX_BYTES,
  PERSONAL_STICKER_MAX_ITEMS,
  PERSONAL_STICKER_TOTAL_BYTES,
  personalStickerUrl,
  type PersonalStickerDto
} from '@/lib/chat-stickers';
import { Alert, EmptyState, LoadingBlock, Modal, Spinner, useConfirm, useToast } from '@/components/ui';

const LIBRARY_URL = '/api/account/stickers';
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp';

type PendingSticker = { id: string; file: File; label: string; error?: string };

function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

function labelFromName(filename: string) {
  const name = filename.replace(/\.[^.]+$/, '').trim();
  if (/^[a-f\d_ -]+$/i.test(name) || [...name].length > PERSONAL_STICKER_LABEL_LIMIT) return '';
  return name.replace(/[^\p{L}\p{M}\p{N}\p{S}\p{Zs}、，。！？,.!?'’_-]+/gu, ' ').trim();
}

function DraftPreview({ file }: { file: File }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!ACCEPT.split(',').includes(file.type) || file.size > PERSONAL_STICKER_MAX_BYTES) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="h-12 w-12 shrink-0 object-contain" width={48} height={48} />
  ) : (
    <Smile aria-hidden="true" className="h-6 w-12 shrink-0 text-white/45" />
  );
}

export function StickersPanel() {
  const nextDraftId = useRef(0);
  const { confirm } = useConfirm();
  const { push } = useToast();
  const [stickers, setStickers] = useState<PersonalStickerDto[]>([]);
  const [pending, setPending] = useState<PendingSticker[]>([]);
  const [maxFileBytes, setMaxFileBytes] = useState(PERSONAL_STICKER_MAX_BYTES);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mutating, setMutating] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<PersonalStickerDto | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<{ stickers: PersonalStickerDto[]; maxFileBytes: number }>(LIBRARY_URL, { signal });
      setStickers(data.stickers);
      setMaxFileBytes(data.maxFileBytes);
      setLoaded(true);
    } catch (err) {
      if (!signal?.aborted) setError(errorMessage(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function queueFiles(files: FileList | null) {
    if (!files?.length) return;
    const available = Math.max(0, PERSONAL_STICKER_MAX_ITEMS - stickers.length - pending.length);
    const choices = Array.from(files).slice(0, available).map((file) => ({
      id: String(nextDraftId.current++),
      file,
      label: labelFromName(file.name),
      ...(file.size > maxFileBytes ? { error: `超过每张 ${fileSize(maxFileBytes)} 的限制` } : {})
    }));
    setError(files.length > available ? `这次还可加入 ${available} 张，已按选择顺序加入` : '');
    setPending((current) => [...current, ...choices]);
  }

  async function importFiles(event: React.FormEvent) {
    event.preventDefault();
    setUploading(true);
    setError('');
    let saved = 0;
    for (const item of pending) {
      if (item.file.size > maxFileBytes) continue;
      const body = new FormData();
      body.set('file', item.file);
      body.set('label', item.label.trim());
      try {
        const data = await apiFetch<{ sticker: PersonalStickerDto }>(LIBRARY_URL, { method: 'POST', body });
        setStickers((current) => [data.sticker, ...current]);
        setPending((current) => current.filter((entry) => entry.id !== item.id));
        saved++;
      } catch (err) {
        setPending((current) => current.map((entry) => entry.id === item.id ? { ...entry, error: errorMessage(err) } : entry));
      }
    }
    setUploading(false);
    if (saved) push(`已导入 ${saved} 张表情包`);
  }

  async function update(id: PersonalStickerDto['id'], patch: { enabled?: boolean; label?: string }) {
    setMutating(id);
    setError('');
    try {
      const data = await apiFetch<{ sticker: PersonalStickerDto }>(personalStickerUrl(id), { method: 'PATCH', json: patch });
      setStickers((current) => current.map((sticker) => sticker.id === id ? data.sticker : sticker));
      setEditing(null);
      push('表情包已更新');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setMutating('');
    }
  }

  async function remove(sticker: PersonalStickerDto) {
    const accepted = await confirm({
      title: `永久删除「${sticker.label}」？`,
      description: '图片会从你的表情库移除。聊天历史里已发出的同一张图也会无法显示。',
      confirmText: '永久删除',
      tone: 'danger'
    });
    if (!accepted) return;
    setMutating(sticker.id);
    setError('');
    try {
      await apiFetch(personalStickerUrl(sticker.id), { method: 'DELETE' });
      setStickers((current) => current.filter((item) => item.id !== sticker.id));
      push('表情包已删除');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setMutating('');
    }
  }

  const totalBytes = stickers.reduce((total, sticker) => total + sticker.size, 0);
  const full = stickers.length + pending.length >= PERSONAL_STICKER_MAX_ITEMS || totalBytes >= PERSONAL_STICKER_TOTAL_BYTES;
  const hasUpload = pending.some((item) => item.file.size <= maxFileBytes);

  return (
    <>
      <section className="panel space-y-4 p-4 sm:p-6" aria-labelledby="personal-stickers-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 id="personal-stickers-title" className="text-xl font-semibold text-white">表情包</h1>
            <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-slate-300">
              导入你喜欢的微信表情图片或动图。AI 会参考标签，偶尔在语气合适时选一张随回复发出。
            </p>
          </div>
          <label className="btn-primary cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-aurora-300 aria-disabled:cursor-not-allowed aria-disabled:opacity-50" aria-disabled={!loaded || full || uploading}>
            <ImagePlus aria-hidden="true" className="h-4 w-4" />
            选择本地图片
            <input
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              disabled={!loaded || full || uploading}
              onChange={(event) => {
                queueFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-white/10 pt-3 text-xs text-slate-400">
          <span>PNG、JPEG、GIF、WebP</span>
          <span>每张最多 {fileSize(maxFileBytes)}</span>
          {loaded ? <span>{stickers.length}/{PERSONAL_STICKER_MAX_ITEMS} 张 · {totalBytes ? fileSize(totalBytes) : '0 KB'} / {fileSize(PERSONAL_STICKER_TOTAL_BYTES)}</span> : null}
        </div>
        {error ? (
          <Alert tone="error">
            {error}
            {!loaded ? <button type="button" className="btn-ghost ml-2" onClick={() => void load()}>重试</button> : null}
          </Alert>
        ) : null}
        {pending.length ? (
          <form className="space-y-3" onSubmit={importFiles}>
            <p className="text-[13px] text-slate-300">给每张图一个能说明用法的标签，例如「猫猫鼓掌」「得意地笑」。</p>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {pending.map((item) => (
                <div key={item.id} className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
                  <DraftPreview file={item.file} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 truncate text-xs text-slate-400" title={item.file.name}>{item.file.name}</p>
                    <input
                      className="field"
                      aria-label={`${item.file.name} 的表情标签`}
                      placeholder="输入表情标签"
                      value={item.label}
                      maxLength={PERSONAL_STICKER_LABEL_LIMIT * 2}
                      required={item.file.size <= maxFileBytes}
                      disabled={uploading || item.file.size > maxFileBytes}
                      onChange={(event) => {
                        const label = event.target.value;
                        setPending((current) => current.map((entry) => entry.id === item.id ? { ...entry, label, error: undefined } : entry));
                      }}
                    />
                    {item.error ? <p className="mt-1 text-xs text-red-300" role="alert">{item.error}</p> : null}
                  </div>
                  <button
                    type="button"
                    className="btn-ghost shrink-0"
                    disabled={uploading}
                    onClick={() => setPending((current) => current.filter((entry) => entry.id !== item.id))}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
            <button type="submit" className="btn-primary" disabled={uploading || !hasUpload}>
              {uploading ? <Spinner /> : null}
              {uploading ? '正在导入…' : '导入表情包'}
            </button>
          </form>
        ) : null}
      </section>

      <section className="panel p-4 sm:p-6" aria-labelledby="personal-sticker-library-title">
        <h2 id="personal-sticker-library-title" className="font-semibold text-white">我的表情包</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-300">停用后，新回复不会选这张图，已经发出的图片仍会保留。</p>
        {loading ? <LoadingBlock label="正在读取表情包" /> : null}
        {loaded && !stickers.length ? (
          <EmptyState icon={<Smile className="h-5 w-5" />} title="还没有导入表情包" description="导入后，你的表情会和内置表情一起供 AI 选择。" />
        ) : null}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {stickers.map((sticker) => (
            <article key={sticker.id} className="flex min-w-0 items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={personalStickerUrl(sticker.id)} alt="" width={56} height={56} loading="lazy" className="h-14 w-14 shrink-0 object-contain" />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-sm font-medium text-white">{sticker.label}</h3>
                <p className="mt-0.5 text-xs text-slate-400">{sticker.enabled ? '可供 AI 选择' : '已停用'} · {fileSize(sticker.size)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <button type="button" className="btn-ghost !px-2 !py-1 !text-xs" disabled={!!mutating} onClick={() => void update(sticker.id, { enabled: !sticker.enabled })}>
                    {sticker.enabled ? '停用' : '启用'}
                  </button>
                  <button type="button" className="btn-ghost !px-2 !py-1 !text-xs" disabled={!!mutating} onClick={() => { setEditing(sticker); setEditingLabel(sticker.label); }}>改标签</button>
                  <button type="button" className="btn-ghost !px-2 !py-1 !text-xs text-red-300" disabled={!!mutating} onClick={() => void remove(sticker)}>删除</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Modal open={!!editing} title="修改表情标签" onClose={() => { if (!mutating) setEditing(null); }}>
        {editing ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void update(editing.id, { label: editingLabel }); }}>
            <label className="block text-sm text-slate-300">
              表情标签
              <input className="field mt-1.5" value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} maxLength={PERSONAL_STICKER_LABEL_LIMIT * 2} required />
            </label>
            <div className="flex justify-end">
              <button type="submit" className="btn-primary" disabled={!!mutating}>{mutating ? <Spinner /> : null} 保存</button>
            </div>
          </form>
        ) : null}
      </Modal>
    </>
  );
}
