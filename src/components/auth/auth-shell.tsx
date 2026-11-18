import type { ReactNode } from 'react';
import Link from 'next/link';
import { LockKeyhole } from 'lucide-react';
import { BrandWordmark } from '@/components/brand';
import { OrbitScene } from '@/components/orbit-scene';

export function AuthShell({
  siteName,
  title,
  subtitle,
  children,
  footer,
  wide
}: {
  siteName: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-6 sm:px-8 sm:py-10">
      <div className="auth-panel grid w-full max-w-[1152px] overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#0d131b] shadow-[0_26px_100px_-42px_#000] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <aside className="auth-showcase relative hidden min-w-0 flex-col overflow-hidden border-r border-white/10 p-10 lg:flex xl:p-12">
          <Link href="/" className="relative w-fit max-w-full rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-aurora-400">
            <BrandWordmark name={siteName} compact />
          </Link>

          <div className="relative my-auto pb-3 pt-6">
            <div className="mx-auto -mb-1 w-[280px] max-w-full">
              <OrbitScene compact />
            </div>
            <h2 className="text-[clamp(2rem,3.1vw,2.75rem)] font-semibold leading-[1.24] tracking-tight text-white">
              从一个问题开始
            </h2>
            <p className="mt-3 max-w-[24rem] text-sm leading-7 text-[#adbfca]">
              整理思路、讨论方案，或者继续上次的对话。
            </p>
          </div>

          <p className="relative mt-9 flex items-center gap-2 text-xs text-[#a4b8bf]">
            <LockKeyhole aria-hidden="true" className="h-4 w-4 shrink-0 text-aurora-300/80" />
            对话记录在服务器上加密保存
          </p>
        </aside>

        <section className="auth-form-enter flex min-w-0 flex-col justify-center px-5 py-8 sm:px-10 sm:py-12">
          <Link href="/" className="mb-9 w-fit max-w-full rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-aurora-400 lg:hidden">
            <BrandWordmark name={siteName} compact />
          </Link>
          <div className={`mx-auto w-full ${wide ? 'max-w-[480px]' : 'max-w-[370px]'}`}>
            <div className="mb-6">
              <h1 className="text-[clamp(1.625rem,4vw,2.125rem)] font-semibold leading-tight tracking-tight text-white">{title}</h1>
              <p className="mt-2.5 text-sm leading-6 text-[#a4b3c2]">{subtitle}</p>
            </div>
            {children}
            {footer ? (
              <div className="mt-6 border-t border-white/10 pt-5 text-center text-[13px] leading-6 text-[#a4b3c2]">
                {footer}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
