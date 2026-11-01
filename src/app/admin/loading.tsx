import { Spinner } from '@/components/ui';

// /admin 是 force-dynamic：软跳转时没有路由级 Suspense 边界，浏览器只能停在旧页面上
// 等 SSR。这里的骨架复刻 AdminShell 的几何（同宽容器 + 230px 侧栏 + 四张统计卡），
// 避免出现跳动；骨架本身不含任何文案。
export default function AdminLoading() {
  return (
    <div className="relative min-h-[100dvh]">
      <header className="sticky top-0 z-30 h-16 border-b border-white/[0.06] bg-[#07090f]/85 backdrop-blur-xl" />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="hidden space-y-1.5 lg:block">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-9 rounded-xl bg-white/[0.05]" />
          ))}
        </div>
        <div className="min-w-0 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-24 rounded-2xl bg-white/[0.05]" />
            ))}
          </div>
          <div className="flex justify-center py-12">
            <Spinner className="h-5 w-5 text-white/40" />
          </div>
        </div>
      </div>
    </div>
  );
}
