'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ShieldCheck, Wifi } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { cn } from '@/lib/cn';

export function IntroLanding({
  siteName,
  registrationOpen
}: {
  siteName: string;
  registrationOpen: boolean;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [ready, setReady] = useState(false);

  const enter = useCallback(() => {
    setLeaving(true);
    setTimeout(() => router.replace('/login'), 380);
  }, [router]);

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem('fac_intro_seen') === '1';
      sessionStorage.setItem('fac_intro_seen', '1');
    } catch {
      seen = false;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delay = reduced ? 700 : seen ? 900 : 3900;
    const timer = setTimeout(enter, delay);
    setReady(true);
    return () => clearTimeout(timer);
  }, [enter]);

  return (
    <main
      className={cn(
        'relative flex min-h-dvh flex-col overflow-hidden px-6',
        leaving ? 'intro-exit' : ready ? 'opacity-100' : 'opacity-0'
      )}
      style={{ transition: 'opacity .4s ease' }}
    >
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2.5">
          <BrandMark size={26} />
          <span className="text-[13px] font-medium tracking-wide text-white/70">{siteName}</span>
        </div>
        <button
          type="button"
          onClick={enter}
          className="group flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-[12px] text-white/55 transition hover:border-white/20 hover:text-white"
        >
          跳过动画
          <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
        </button>
      </header>

      <div className="relative flex flex-1 flex-col items-center justify-center pb-20 text-center">
        <div className="relative mb-10 flex h-52 w-52 items-center justify-center sm:h-64 sm:w-64">
          <div className="intro-ring absolute inset-0 rounded-full border border-aurora-400/20" />
          <div
            className="intro-ring absolute inset-5 rounded-full border border-dashed border-white/10"
            style={{ animationDirection: 'reverse', animationDuration: '14s' }}
          />
          <div className="intro-ring absolute inset-12 rounded-full border border-violet-400/15" style={{ animationDuration: '20s' }} />
          <div className="intro-orb relative flex h-24 w-24 items-center justify-center rounded-full bg-[radial-gradient(circle_at_34%_28%,#eafff8,#4fe0b4_40%,#0b7d5c_100%)] shadow-[0_0_80px_rgba(79,224,180,0.45)] sm:h-28 sm:w-28">
            <div className="absolute inset-0 rounded-full border border-white/25" />
            <div className="h-[38%] w-[38%] rounded-full bg-white/25 blur-md" />
          </div>
          <span className="absolute right-2 top-9 h-1.5 w-1.5 rounded-full bg-aurora-300 shadow-[0_0_10px_#8ff0d0]" />
          <span className="absolute bottom-8 left-4 h-1 w-1 rounded-full bg-violet-300/80" />
        </div>

        <h1 className="intro-title text-[30px] font-light tracking-[0.18em] text-white sm:text-[42px]">{siteName}</h1>
        <p className="intro-sub mt-4 max-w-md text-[13px] leading-relaxed tracking-wide text-white/40 sm:text-sm">
          私有部署的 AI 空间。对话加密保存，
          <br className="hidden sm:block" />
          仅授权网络与账号，方可进入。
        </p>
        <div className="intro-cta mt-9 flex flex-wrap items-center justify-center gap-2 text-[11px] text-white/35">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-aurora-400" /> 零信任接入
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5">
            <Wifi className="h-3.5 w-3.5 text-aurora-400" /> 加密存储
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5">
            {registrationOpen ? '注册开放中' : '仅限授权加入'}
          </span>
        </div>
      </div>

      <footer className="pb-8 text-center text-[10px] uppercase tracking-[0.32em] text-white/20">
        Authorized networks only · Zero public entry
      </footer>

      {!leaving ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-white/[0.06]">
          <div
            className="h-px bg-gradient-to-r from-transparent via-aurora-400/70 to-transparent"
            style={{ animation: 'introProgress 3.9s linear forwards' }}
          />
        </div>
      ) : null}
      <style>{`@keyframes introProgress{from{width:0}to{width:100%}}`}</style>
    </main>
  );
}
