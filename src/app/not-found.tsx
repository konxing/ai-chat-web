import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-950 px-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.03] p-8 text-center">
        <div className="text-xs tracking-[0.35em] text-aurora-400/70">FAMILY · AI</div>
        <h1 className="mt-6 text-4xl font-semibold text-white">404</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">页面不存在，或你没有访问它的权限。</p>
        <Link
          href="/chat"
          className="mt-7 inline-flex rounded-full bg-aurora-400 px-5 py-2.5 text-sm font-medium text-ink-950 transition hover:bg-aurora-400/90"
        >
          返回对话
        </Link>
      </div>
    </main>
  );
}
