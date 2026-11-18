'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, Search, Smile, Sparkles } from 'lucide-react';
import { CHAT_STICKERS } from '@/lib/chat-stickers';
import { EmptyState, Modal } from '@/components/ui';

type Category = 'all' | 'animated' | 'reactions' | 'cats';
type GallerySticker = {
  id: string;
  src: string;
  posterSrc?: string;
  alt: string;
  category: Exclude<Category, 'all'>;
  search: string;
};

const PAGE_SIZE = 24;
const CATEGORY_ORDER = { animated: 0, reactions: 1, cats: 2 };
const STICKERS: GallerySticker[] = Object.entries(CHAT_STICKERS).map(([id, sticker]): GallerySticker => {
  const category = 'posterSrc' in sticker ? 'animated' : sticker.src.startsWith('/stickers/reactions/') ? 'reactions' : 'cats';
  const tags = 'tags' in sticker ? sticker.tags.join(' ') : '';
  return { id, ...sticker, category, search: `${sticker.alt} ${tags}`.toLowerCase() };
}).sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);
const CATEGORIES: { id: Category; label: string; count: number }[] = [
  { id: 'all', label: '全部', count: STICKERS.length },
  { id: 'animated', label: '动态表情', count: STICKERS.filter((sticker) => sticker.category === 'animated').length },
  { id: 'reactions', label: '趣味贴纸', count: STICKERS.filter((sticker) => sticker.category === 'reactions').length },
  { id: 'cats', label: '文字猫猫', count: STICKERS.filter((sticker) => sticker.category === 'cats').length }
];

export function BuiltInStickerGallery() {
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<GallerySticker | null>(null);
  const [playing, setPlaying] = useState(false);
  const needle = query.trim().toLowerCase();
  const matching = STICKERS.filter((sticker) =>
    (category === 'all' || sticker.category === category) && (!needle || sticker.search.includes(needle)));
  const pageCount = Math.ceil(matching.length / PAGE_SIZE);
  const visible = matching.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section className="panel space-y-4 p-4 sm:p-6" aria-labelledby="builtin-stickers-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="builtin-stickers-title" className="flex items-center gap-2 text-base font-semibold text-white">
            <Sparkles aria-hidden="true" className="h-4 w-4 text-aurora-300" />
            内置表情库
            <span className="rounded-full border border-aurora-300/20 bg-aurora-300/10 px-2 py-0.5 text-xs font-medium text-aurora-200">{STICKERS.length} 张</span>
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-300">
            所有内置表情都在这里，AI 会根据聊天选择。点击图片可放大预览，动图点开后播放。
          </p>
        </div>
        <label className="relative block w-full sm:w-56">
          <span className="sr-only">搜索内置表情</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="search" className="field !pl-9 !text-sm" placeholder="搜索表情，如抱抱、互怼" value={query} maxLength={80}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        </label>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="表情分类">
        {CATEGORIES.map((item) => (
          <button key={item.id} type="button" aria-pressed={category === item.id}
            onClick={() => { setCategory(item.id); setPage(0); }}
            className={`rounded-full border px-3 py-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aurora-300 ${category === item.id
              ? 'border-aurora-300/40 bg-aurora-300/15 text-aurora-200'
              : 'border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25 hover:bg-white/[0.07]'}`}>
            {item.label}<span className="ml-1.5 tabular-nums opacity-70">{item.count}</span>
          </button>
        ))}
      </div>

      {matching.length ? (
        <div className="grid grid-cols-3 gap-2 min-[420px]:grid-cols-4 sm:grid-cols-6 lg:grid-cols-8">
          {visible.map((sticker) => (
            <button key={sticker.id} type="button" aria-label={`预览${sticker.posterSrc ? '动图' : '表情'}：${sticker.alt}`}
              className="group relative flex min-w-0 flex-col items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-gradient-to-b from-white/[0.045] to-transparent px-2 py-3 text-center transition-colors hover:border-aurora-300/30 hover:bg-aurora-300/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aurora-300"
              onClick={() => { setPreview(sticker); setPlaying(!!sticker.posterSrc); }}>
              {sticker.posterSrc ? <Play aria-hidden="true" className="absolute right-2 top-2 h-3 w-3 text-aurora-300/80" /> : null}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sticker.posterSrc ?? sticker.src} alt="" width={64} height={64} loading="lazy" decoding="async" className="h-16 w-16 object-contain" />
              <span className="w-full break-words text-[11px] leading-4 text-slate-300 group-hover:text-white">{sticker.alt}</span>
            </button>
          ))}
        </div>
      ) : <EmptyState icon={<Smile className="h-5 w-5" />} title="没有找到这个表情" description="试试「开心」「猫」「加油」，或切换到全部分类。" />}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
        <p className="text-xs text-slate-400" role="status">
          {matching.length ? `第 ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, matching.length)} 张，共 ${matching.length} 张` : '共 0 张'}
        </p>
        {pageCount > 1 ? (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-xs" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
              <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />上一页
            </button>
            <span className="text-xs tabular-nums text-slate-400">{page + 1} / {pageCount}</span>
            <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-xs" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>
              下一页<ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <p className="text-xs leading-relaxed text-slate-400">
        动图素材来自 Google 的
        <a className="ml-1 text-aurora-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aurora-400"
          href="https://googlefonts.github.io/noto-emoji-animation/" target="_blank" rel="noreferrer">Animated Noto Emoji</a>
        <span>（<a className="text-aurora-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-aurora-400"
          href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>）。</span>
      </p>

      <Modal open={!!preview} title={preview?.alt ?? '表情预览'} onClose={() => { setPreview(null); setPlaying(false); }} width="380px">
        {preview ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex h-56 w-full items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={playing || !preview.posterSrc ? preview.src : preview.posterSrc} alt={preview.alt} width={192} height={192} decoding="async" className="h-48 w-48 object-contain" />
            </div>
            {preview.posterSrc ? (
              <button type="button" className="btn-ghost !text-sm" onClick={() => setPlaying((current) => !current)}>
                {playing ? <Pause aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
                {playing ? '暂停动图' : '播放动图'}
              </button>
            ) : <p className="text-xs text-slate-400">这张是静态表情，AI 可以在聊天中选用。</p>}
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
