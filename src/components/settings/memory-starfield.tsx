'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Orbit } from 'lucide-react';
import { GRAPH_CONTEXT_COLORS, truncateNodeLabel } from '@/lib/cognitive/memory-graph-display';
import type { GraphEdgeKind } from '@/lib/cognitive/memory-graph';
import type { MemoryContext } from '@/lib/cognitive/policy';
import { cn } from '@/lib/cn';

/**
 * 记忆星图（3D）。手写 Canvas 投影，不引图形库：单 rAF 循环、阻尼轨道、像素比封顶、
 * 深度排序 + 雾衰减 + 加色光晕 + 漂移星尘 + 星云背景。
 * 交互：鼠标拖拽旋转、滚轮/双指缩放、点击星点聚焦；自动旋转可开关；其余观感参数固定默认。
 * 坐标只用于把点铺开并按主题聚簇，不表示任何真实距离。
 */

export interface StarNode {
  id: string;
  content: string;
  context: MemoryContext;
  isCurrent: boolean;
  weight: number;
}
export interface StarEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export const STAR_EDGE_COLORS: Record<GraphEdgeKind, string> = {
  relation: '#b7a4ff',
  update: '#eaf2ff',
  sameChat: '#9fb6d8',
  coCitation: '#7f95b5'
};
export const STAR_EDGE_DASHES: Record<GraphEdgeKind, number[]> = {
  relation: [2, 4],
  update: [],
  sameChat: [6, 5],
  coCitation: [2, 5]
};

/** 固定默认观感（不提供实时调节滑杆）。 */
const RENDER = {
  rotateSpeed: 0.35,
  nodeScale: 1,
  glow: 0.7,
  linkOpacity: 0.6,
  dust: 0.5,
  fog: 0.5,
  labels: true
};
const BG: [string, string] = ['#04101c', '#071a24'];
const NEBULA: [string, string, string] = [
  'rgba(47,224,180,0.16)',
  'rgba(64,140,255,0.12)',
  'rgba(122,91,208,0.10)'
];
const DUST_COLOR = '#9fe8d8';

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Vec3 { x: number; y: number; z: number }

function buildLayout(nodes: StarNode[], seed: number): Vec3[] {
  const rand = mulberry32(seed);
  const contexts = [...new Set(nodes.map((n) => n.context))];
  const centers = new Map<MemoryContext, Vec3>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  contexts.forEach((c, i) => {
    const y = contexts.length === 1 ? 0 : 1 - (2 * (i + 0.5)) / contexts.length;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * golden;
    centers.set(c, { x: Math.cos(a) * r * 150, y: y * 150, z: Math.sin(a) * r * 150 });
  });
  const pos = nodes.map((n) => {
    const c = centers.get(n.context)!;
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(Math.max(0, 1 - u * u));
    const spread = 34 + rand() * 46;
    return { x: c.x + Math.cos(a) * rr * spread, y: c.y + u * spread, z: c.z + Math.sin(a) * rr * spread };
  });
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y, dz = pos[j].z - pos[i].z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
        const min = 30;
        if (d < min) {
          const push = (min - d) / d / 2;
          pos[i].x -= dx * push; pos[i].y -= dy * push; pos[i].z -= dz * push;
          pos[j].x += dx * push; pos[j].y += dy * push; pos[j].z += dz * push;
        }
      }
    }
  }
  return pos;
}

export function MemoryStarfield({
  nodes,
  edges,
  selectedId,
  onSelect,
  maxWeight
}: {
  nodes: StarNode[];
  edges: StarEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  maxWeight: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [autoRotate, setAutoRotate] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? false : true
  );
  const [supported, setSupported] = useState(true);
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const layout = useMemo(() => buildLayout(nodes, hashSeed(nodes.map((n) => n.id).join('|'))), [nodes]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const maxWeightRef = useRef(maxWeight);
  maxWeightRef.current = maxWeight;

  // 阻尼轨道：target 由输入驱动，当前值每帧逼近，拖拽全程保持满画质。
  const viewRef = useRef({ yaw: 0.6, pitch: 0.28, dist: 430, tYaw: 0.6, tPitch: 0.28, tDist: 430 });
  const hoverRef = useRef<string | null>(null);

  const exportPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'memory-starfield.png';
    a.click();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setSupported(false);
      return;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    let width = 0, height = 0;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = wrap.clientWidth;
      height = wrap.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const dustRand = mulberry32(99);
    const dust = Array.from({ length: 220 }, () => {
      const u = dustRand() * 2 - 1;
      const a = dustRand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      const rad = 300 + dustRand() * 260;
      return { x: Math.cos(a) * r * rad, y: u * rad, z: Math.sin(a) * r * rad, phase: dustRand() * Math.PI * 2, size: 0.5 + dustRand() * 1.3 };
    });

    const project = (p: Vec3, v: { yaw: number; pitch: number; dist: number }) => {
      const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
      const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
      const x1 = p.x * cy + p.z * sy;
      const z1 = -p.x * sy + p.z * cy;
      const y1 = p.y * cp - z1 * sp;
      const z2 = p.y * sp + z1 * cp;
      const depth = z2 + v.dist;
      const scale = 520 / Math.max(80, depth);
      return { x: width / 2 + x1 * scale, y: height / 2 + y1 * scale, scale, depth };
    };

    const pick = (mx: number, my: number): string | null => {
      const v = viewRef.current;
      const ns = nodesRef.current;
      const pos = layoutRef.current;
      let best: string | null = null;
      let bestScore = Infinity;
      for (let i = 0; i < ns.length; i++) {
        const pr = project(pos[i], v);
        const r = (3.5 + 6 * Math.sqrt((ns[i].weight || 0) / Math.max(1, maxWeightRef.current))) * RENDER.nodeScale * pr.scale;
        const d = Math.hypot(pr.x - mx, pr.y - my);
        if (d <= r + 8) {
          const score = d + pr.depth * 0.01;
          if (score < bestScore) { bestScore = score; best = ns[i].id; }
        }
      }
      return best;
    };

    // 拖拽旋转 / 双指缩放 / 点击聚焦（用位移阈值区分点击与拖拽）。
    const pointers = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let moved = 0;
    let pinchDist = 0;
    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { dragging = true; moved = 0; canvas.style.cursor = 'grabbing'; }
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (!pointers.has(e.pointerId)) {
        hoverRef.current = pick(mx, my);
        canvas.style.cursor = hoverRef.current ? 'pointer' : 'grab';
        return;
      }
      const prev = pointers.get(e.pointerId)!;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = viewRef.current;
      if (pointers.size === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        v.tYaw += dx * 0.005;
        v.tPitch = clamp(v.tPitch + dy * 0.005, -1.35, 1.35);
      } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist > 0) v.tDist = clamp(v.tDist * (pinchDist / Math.max(1, d)), 220, 900);
        pinchDist = d;
        moved += 10;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        dragging = false;
        canvas.style.cursor = 'grab';
        if (moved < 5) {
          const rect = canvas.getBoundingClientRect();
          const id = pick(e.clientX - rect.left, e.clientY - rect.top);
          onSelectRef.current(id && id === selectedRef.current ? null : id);
        }
      }
      pinchDist = 0;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      v.tDist = clamp(v.tDist * Math.exp(e.deltaY * 0.001), 220, 900);
    };
    const onKey = (e: KeyboardEvent) => {
      const v = viewRef.current;
      if (e.key === 'ArrowLeft') v.tYaw -= 0.15;
      else if (e.key === 'ArrowRight') v.tYaw += 0.15;
      else if (e.key === 'ArrowUp') v.tPitch = clamp(v.tPitch - 0.12, -1.35, 1.35);
      else if (e.key === 'ArrowDown') v.tPitch = clamp(v.tPitch + 0.12, -1.35, 1.35);
      else if (e.key === '+' || e.key === '=') v.tDist = clamp(v.tDist * 0.9, 220, 900);
      else if (e.key === '-') v.tDist = clamp(v.tDist * 1.1, 220, 900);
      else return;
      e.preventDefault();
    };
    const onLeave = () => { hoverRef.current = null; };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.style.cursor = 'grab';

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const v = viewRef.current;
      if (autoRotateRef.current && !dragging && !reduced) v.tYaw += RENDER.rotateSpeed * dt * 0.6;
      v.yaw += (v.tYaw - v.yaw) * 0.12;
      v.pitch += (v.tPitch - v.pitch) * 0.12;
      v.dist += (v.tDist - v.dist) * 0.12;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, BG[0]);
      bg.addColorStop(1, BG[1]);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      const blobs: Array<[number, number, number, string]> = [
        [width * 0.22, height * 0.24, Math.max(width, height) * 0.5, NEBULA[0]],
        [width * 0.82, height * 0.7, Math.max(width, height) * 0.45, NEBULA[1]],
        [width * 0.6, height * 0.12, Math.max(width, height) * 0.35, NEBULA[2]]
      ];
      for (const [bx, by, br, color] of blobs) {
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      const ns = nodesRef.current;
      const pos = layoutRef.current;
      const es = edgesRef.current;
      const idx = new Map(ns.map((n, i) => [n.id, i]));
      const projected = pos.map((p) => project(p, v));
      const depthMin = Math.min(...projected.map((p) => p.depth), 1);
      const depthMax = Math.max(...projected.map((p) => p.depth), 2);
      const fogAlpha = (depth: number) => {
        const t = (depth - depthMin) / Math.max(1, depthMax - depthMin);
        return clamp(1 - RENDER.fog * t * 0.85, 0.12, 1);
      };

      const dustCount = Math.round(30 + RENDER.dust * 190);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < dustCount; i++) {
        const d = dust[i];
        const pr = project(d, v);
        if (pr.depth < 60) continue;
        const tw = reduced ? 0.6 : 0.45 + 0.35 * Math.sin(now * 0.001 + d.phase);
        ctx.globalAlpha = 0.16 * tw * fogAlpha(pr.depth);
        ctx.fillStyle = DUST_COLOR;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, d.size * pr.scale * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      for (const e of es) {
        const a = idx.get(e.from), b = idx.get(e.to);
        if (a === undefined || b === undefined) continue;
        const pa = projected[a], pb = projected[b];
        const alpha = RENDER.linkOpacity * fogAlpha((pa.depth + pb.depth) / 2) * (e.kind === 'relation' || e.kind === 'update' ? 0.9 : 0.55);
        ctx.strokeStyle = STAR_EDGE_COLORS[e.kind];
        ctx.globalAlpha = clamp(alpha, 0, 1);
        ctx.lineWidth = 1.1;
        ctx.setLineDash(STAR_EDGE_DASHES[e.kind]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      const order = ns.map((_, i) => i).sort((a, b) => projected[b].depth - projected[a].depth);
      const t = now * 0.001;
      for (const i of order) {
        const n = ns[i];
        const pr = projected[i];
        const strength = Math.sqrt((n.weight || 0) / Math.max(1, maxWeightRef.current));
        const r = (3.5 + 6 * strength) * RENDER.nodeScale * pr.scale;
        const color = GRAPH_CONTEXT_COLORS[n.context];
        const alpha = fogAlpha(pr.depth);
        const isSel = selectedRef.current === n.id;
        const isHover = hoverRef.current === n.id;
        const tw = reduced ? 1 : 0.85 + 0.15 * Math.sin(t * 1.7 + i);
        ctx.globalCompositeOperation = 'lighter';
        const glowR = r * (3.2 + RENDER.glow * 3.4) * (isSel ? 1.5 : 1);
        const g = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, glowR);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = alpha * (0.16 + RENDER.glow * 0.4) * tw * (0.5 + strength * 0.7) * (isSel ? 1.4 : 1);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, glowR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha * (0.35 + strength * 0.5);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(pr.x - r * 0.25, pr.y - r * 0.25, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
        if (!n.isCurrent || isSel || isHover) {
          ctx.globalAlpha = alpha * (isSel || isHover ? 0.95 : 0.5);
          ctx.strokeStyle = isSel ? '#ffffff' : isHover ? '#e6f4ff' : '#cbd5e1';
          ctx.lineWidth = isSel ? 1.8 : 1.1;
          ctx.setLineDash(n.isCurrent ? [] : [3, 3]);
          ctx.beginPath();
          ctx.arc(pr.x, pr.y, r + (isSel ? 5 : 3.5), 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const showLabel = RENDER.labels && (isSel || isHover || ns.length <= 12 || strength > 0.75);
        if (showLabel) {
          const label = truncateNodeLabel(n.content);
          ctx.globalAlpha = alpha;
          ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(4,10,18,0.85)';
          ctx.strokeText(label, pr.x, pr.y + r + 16);
          ctx.fillStyle = isSel ? '#ffffff' : '#dbe7f5';
          ctx.fillText(label, pr.x, pr.y + r + 16);
        }
        ctx.globalAlpha = 1;
      }
      const vg = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, width, height);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  if (!supported) {
    return (
      <div className="p-6 text-[13px] text-white/60">
        当前环境不支持 Canvas，无法渲染 3D 星图；仍可用右侧列表选择记忆查看关系。
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setAutoRotate((v) => !v)}
          aria-pressed={autoRotate}
          className={cn('btn-ghost !px-3 !py-1.5 !text-[12px]', autoRotate && '!border-aurora-400/40 !text-aurora-200')}
          title={autoRotate ? '关闭自动旋转' : '开启自动旋转'}
        >
          <Orbit className="h-3.5 w-3.5" /> 自动旋转：{autoRotate ? '开' : '关'}
        </button>
        <button type="button" onClick={exportPng} className="btn-primary !px-3 !py-1.5 !text-[12px]" title="导出当前画面 PNG">
          <Download className="h-3.5 w-3.5" /> 导出
        </button>
      </div>
      <div
        ref={wrapRef}
        className="relative h-[380px] w-full overflow-hidden rounded-2xl border border-white/10 sm:h-[460px]"
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label="记忆 3D 星图：拖拽旋转、滚轮缩放、点击聚焦；方向键旋转、加减号缩放；自动旋转可开关"
          className="block h-full w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-aurora-400/50"
        />
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-white/10 bg-black/35 px-2.5 py-1 text-[11px] text-white/60 backdrop-blur">
          拖拽旋转 · 滚轮缩放 · 点击聚焦
        </div>
      </div>
    </div>
  );
}