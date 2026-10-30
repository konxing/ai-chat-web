'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function ErrorPage({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('page.error', error.digest ?? error.message);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-950 px-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.03] p-8 text-center">
        <div className="text-xs tracking-[0.35em] text-aurora-400/70">FAMILY · AI</div>
        <h1 className="mt-6 text-2xl font-semibold text-white">页面暂时无法加载</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          可能是网络波动或服务正在更新。你的对话数据不会丢失。
        </p>
        <div className="mt-7 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-aurora-400 px-5 py-2.5 text-sm font-medium text-ink-950 transition hover:bg-aurora-300"
          >
            重试
          </button>
          <Link
            href="/chat"
            className="rounded-full border border-white/10 px-5 py-2.5 text-sm text-slate-300 transition hover:border-white/25"
          >
            返回对话
          </Link>
        </div>
      </div>
    </main>
  );
}
