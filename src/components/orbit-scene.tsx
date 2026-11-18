import { cn } from '@/lib/cn';
import './orbit-scene.css';

export function OrbitScene({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn('orbit-scene', compact && 'orbit-scene-compact', className)} aria-hidden="true">
      <div className="orbit-aura" />
      <div className="orbit-floor" />
      <div className="orbit-stage">
        <div className="orbit-ring orbit-ring-outer"><i className="orbit-satellite" /></div>
        <div className="orbit-ring orbit-ring-middle"><i className="orbit-satellite" /></div>
        <div className="orbit-ring orbit-ring-inner" />
        <div className="orbit-sphere">
          <span className="orbit-sphere-light" />
          <span className="orbit-sphere-arc" />
        </div>
        <span className="orbit-dust orbit-dust-first" />
        <span className="orbit-dust orbit-dust-second" />
      </div>
    </div>
  );
}
