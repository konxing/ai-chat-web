import { Spinner } from '@/components/ui';

// 与 SettingsInner 同宽同列，避免骨架被真实内容顶掉时页面跳一下。
export default function SettingsLoading() {
  return (
    <div className="relative min-h-[100dvh]">
      <header className="sticky top-0 z-30 h-16 border-b border-white/[0.06] bg-[#07090f]/80 backdrop-blur-xl" />
      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="flex gap-1.5 overflow-x-auto lg:flex-col">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-10 w-32 shrink-0 rounded-xl bg-white/[0.05] lg:w-full" />
          ))}
        </div>
        <div className="min-w-0 space-y-5">
          <div className="h-44 rounded-2xl bg-white/[0.05]" />
          <div className="h-56 rounded-2xl bg-white/[0.05]" />
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5 text-white/40" />
          </div>
        </div>
      </main>
    </div>
  );
}
