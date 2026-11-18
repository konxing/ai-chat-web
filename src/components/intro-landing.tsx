'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { BrandWordmark } from '@/components/brand';
import { OrbitScene } from '@/components/orbit-scene';

export function IntroLanding({
  siteName,
  registrationOpen
}: {
  siteName: string;
  registrationOpen: boolean;
}) {
  const router = useRouter();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let seen = false;
    try {
      seen = sessionStorage.getItem('fac_intro_seen') === '1';
      sessionStorage.setItem('fac_intro_seen', '1');
    } catch {
      // The entrance works without session storage.
    }

    const skipForReducedMotion = () => {
      if (!reducedMotion.matches) return;
      window.clearTimeout(timer.current);
      router.replace('/login');
    };
    if (reducedMotion.matches) skipForReducedMotion();
    else timer.current = window.setTimeout(() => router.replace('/login'), seen ? 350 : 1850);
    reducedMotion.addEventListener('change', skipForReducedMotion);
    return () => {
      window.clearTimeout(timer.current);
      reducedMotion.removeEventListener('change', skipForReducedMotion);
    };
  }, [router]);

  return (
    <main className="entry-surface flex min-h-dvh flex-col px-6 sm:px-10">
      <header className="mx-auto w-full max-w-5xl pt-7 sm:pt-9">
        <BrandWordmark name={siteName} compact />
      </header>

      <div className="mx-auto grid w-full max-w-5xl flex-1 content-center items-center gap-2 pb-12 pt-3 text-center md:grid-cols-[1fr_1fr] md:content-stretch md:gap-10 md:pt-6 md:text-left">
        <div className="entry-copy order-2 md:order-1">
          <h1 className="text-[clamp(2.1rem,8vw,3rem)] font-semibold leading-[1.15] tracking-tight text-white md:text-[clamp(2.55rem,5.15vw,4rem)]">
            从一句话开始。
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-sm leading-7 text-slate-300 sm:text-base md:mx-0">
            聊聊你在想什么，或接着上一次的对话。
          </p>
          <Link
            href="/login"
            replace
            onNavigate={() => window.clearTimeout(timer.current)}
            className="btn-primary group mt-7 gap-2.5 rounded-xl px-5 py-3"
          >
            进入 {siteName}
            <ArrowRight aria-hidden="true" className="h-4 w-4 motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
          </Link>
          <p className="mt-7 flex items-center justify-center gap-2 text-xs leading-5 text-slate-400 md:justify-start">
            <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-aurora-300/80" />
            {registrationOpen ? '对话记录加密保存' : '仅限授权账号访问 · 对话记录加密保存'}
          </p>
        </div>

        <div className="order-1 mx-auto flex w-[min(68vw,290px)] items-center justify-center md:order-2 md:w-full">
          <OrbitScene />
        </div>
      </div>
    </main>
  );
}
