import { cn } from '@/lib/cn';

export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className="absolute inset-0 rounded-full opacity-60 blur-md"
        style={{ background: 'radial-gradient(circle at 35% 30%, #b8ffe8, #12a57c 70%, transparent 72%)' }}
      />
      <span
        className="relative rounded-full"
        style={{
          width: size * 0.58,
          height: size * 0.58,
          background: 'radial-gradient(circle at 34% 28%, #eafff8, #4fe0b4 42%, #0f8f6a 100%)',
          boxShadow: '0 0 20px rgba(79,224,180,0.45), inset 0 0 8px rgba(255,255,255,0.35)'
        }}
      />
      <span
        className="absolute rounded-full border border-aurora-400/35"
        style={{ width: size * 0.9, height: size * 0.9 }}
      />
      <span
        className="absolute h-1 w-1 rounded-full bg-aurora-300 shadow-[0_0_6px_rgba(143,240,208,0.9)]"
        style={{ right: size * 0.06, top: size * 0.18 }}
      />
    </span>
  );
}

export function BrandWordmark({ name, compact }: { name: string; compact?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <BrandMark size={compact ? 28 : 34} />
      <span className="min-w-0">
        <span className={cn('block truncate font-semibold tracking-wide text-white', compact ? 'text-[15px]' : 'text-lg')}>
          {name}
        </span>
        {!compact ? (
          <span className="block text-[10px] uppercase tracking-[0.28em] text-white/30">Private Family AI</span>
        ) : null}
      </span>
    </span>
  );
}
