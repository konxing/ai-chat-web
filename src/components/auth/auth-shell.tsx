import type { ReactNode } from 'react';
import Link from 'next/link';
import { KeyRound, LockKeyhole, Network, ShieldCheck } from 'lucide-react';
import { BrandMark, BrandWordmark } from '@/components/brand';

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
    <main className="relative flex min-h-dvh flex-col lg:grid lg:grid-cols-[1.06fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-white/[0.06] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -left-24 top-1/3 h-96 w-96 rounded-full bg-aurora-400/10 blur-[90px]" />
        <div className="pointer-events-none absolute -right-20 bottom-10 h-72 w-72 rounded-full bg-violet-500/10 blur-[80px]" />
        <Link href="/" className="relative inline-flex items-center gap-3 text-white/80">
          <BrandWordmark name={siteName} />
        </Link>

        <div className="relative max-w-lg">
          <div className="mb-7 flex h-16 w-16 items-center justify-center rounded-2xl border border-aurora-400/20 bg-aurora-400/[0.07]">
            <ShieldCheck className="h-7 w-7 text-aurora-300" />
          </div>
          <h2 className="text-[34px] font-light leading-[1.25] tracking-wide text-white">
            星海无声，
            <br />
            此间自成边界。
          </h2>
          <p className="mt-5 text-sm leading-7 text-white/40">
            网络层零信任过滤，未经显式授权的请求无法触及边界。
            存储加密与多维隔离机制，确保每一行对话与凭证，皆锁于无形。
          </p>
          <div className="mt-9 space-y-3 text-[12.5px] text-white/40">
            <div className="flex items-center gap-3">
              <Network className="h-4 w-4 text-aurora-400/80" />
              <span>默认拒绝 · IPv4 / IPv6 白名单</span>
            </div>
            <div className="flex items-center gap-3">
              <LockKeyhole className="h-4 w-4 text-aurora-400/80" />
              <span>Argon2id 口令 · AES-256-GCM 存储</span>
            </div>
            <div className="flex items-center gap-3">
              <KeyRound className="h-4 w-4 text-aurora-400/80" />
              <span>API Key 不出服务器，仅密文落库</span>
            </div>
          </div>
        </div>

        <p className="relative text-[10px] uppercase tracking-[0.28em] text-white/20">
          Private instance · No public sign-up entry
        </p>
      </section>

      <section className="flex flex-1 flex-col px-5 py-6 sm:px-8 lg:justify-center lg:px-12">
        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="text-[15px] font-medium text-white/85">{siteName}</span>
          </Link>
          <span className="chip text-[10px] text-white/35">授权网络</span>
        </div>

        <div className={`mx-auto w-full ${wide ? 'max-w-[560px]' : 'max-w-[420px]'} animate-fade-up`}>
          <div className="mb-7">
            <h1 className="text-[26px] font-semibold tracking-wide text-white">{title}</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-white/40">{subtitle}</p>
          </div>
          <div className="panel p-5 sm:p-7">{children}</div>
          {footer ? <div className="mt-5 text-center text-[12.5px] text-white/35">{footer}</div> : null}
          <p className="mt-8 flex items-center justify-center gap-1.5 text-[10.5px] tracking-wide text-white/20">
            <ShieldCheck className="h-3 w-3" /> 当前连接已通过网络白名单校验
          </p>
        </div>
      </section>
    </main>
  );
}
