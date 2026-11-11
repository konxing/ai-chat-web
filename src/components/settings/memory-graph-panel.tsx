'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Share2 } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, useToast } from '@/components/ui';
import {
  GRAPH_CONTEXT_COLORS,
  GRAPH_EDGE_LABELS,
  describeAssociationGate,
  describeGraphBudget,
  describeNotAGraph,
  graphNodeWeights,
  isGraphDrawable,
  memoryNeighborhood,
  truncateNodeLabel
} from '@/lib/cognitive/memory-graph-display';
import { CONTEXT_LABELS, TYPE_LABELS } from '@/lib/cognitive/memory-display';
import type { GraphEdgeKind, MemoryGraph } from '@/lib/cognitive/memory-graph';
import { MemoryStarfield, STAR_EDGE_COLORS, STAR_EDGE_DASHES } from './memory-starfield';

/**
 * 记忆网络那一屏（任务书 8.2 的界面）。
 *
 * 五条形状是从后端和判词直接落下来的，不是审美选择：
 *
 * 一、**手写 SVG，不引图形库**。d3-force / cytoscape 那一类会替用户算出一张**位置有意义**的图，
 *    而那批坐标既不在库里也解释不了——正是 2a 那次阈值校准判掉的东西。这里的坐标只有一个用途：
 *    把点铺开别重叠，所以这句话就写在画布下面。
 *
 * 二、**画不出来就不画**。`isGraphDrawable` 是唯一的判据（有线且不少于三个点），
 *    判不过时退回记忆列表，并念 `describeNotAGraph` 那句真实条数。
 *    散点连成装饰、或者一句「暂无数据」糊过去，都是把「还没连起来」演成「它们彼此相关」。
 *
 * 三、**这一屏只读**。纠正、永久删除、归档的入口在「记忆」和「认知时间线」两屏已经各有一个，
 *    这里再开一对就是第三个入口、第三套文案。要看这条记忆的完整说法，点开它自己就够了。
 *
 * 四、**开关和闸门各管一头**。界面上关着时连请求都不发；服务端那两道闸门（`associationEnabled`
 *    与 `memoryEnabled`）绕过去照样 409，界面上的「关」不是唯一那道闸。
 *    `associationEnabled` 这一屏是它第一个消费者——在那之前它只是库里的一个布尔值。
 *
 * 五、**情境那列 `allowAssociation` 挡的是线，不是点**。被关掉的行还在图上、还能点开，
 *    只是不为它画关联线（更新关系照旧）。这条界线和「隐藏」的界线差得很远，所以界面上必须说条数：
 *    画得出来时念 `describeAssociationGate`，画不出来时那个数字由 `describeNotAGraph` 说——
 *    同一个数在两句里，所以这两句在界面上互斥，不能同时冒出来。
 */

const GRAPH_URL = '/api/account/cognitive/graph';
const PREFERENCES_URL = '/api/account/cognitive';

type GraphPayload = MemoryGraph & { chats: Record<string, string> };

export function MemoryGraphPanel() {
  const { push } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [chats, setChats] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<GraphPayload>(GRAPH_URL);
      setGraph(data);
      setChats(data.chats);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await apiFetch<{ preferences: { associationEnabled: boolean } }>(PREFERENCES_URL);
        setEnabled(data.preferences.associationEnabled);
      } catch {
        // 开关读不到就保持 null：界面显示「状态未知」，而不是假装它是关着的。
      }
    })();
  }, []);

  /** 只在开关确认是打开时读图：关着那一趟请求服务端也会 409，白跑一次解密。 */
  useEffect(() => {
    if (enabled === true) void loadGraph();
  }, [enabled, loadGraph]);

  async function toggleEnabled() {
    if (enabled === null || flagBusy) return;
    setFlagBusy(true);
    try {
      const data = await apiFetch<{ preferences: { associationEnabled: boolean } }>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { associationEnabled: !enabled }
      });
      setEnabled(data.preferences.associationEnabled);
      push(data.preferences.associationEnabled ? '记忆网络已打开' : '记忆网络已关闭');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  const focus = useMemo(() => graph && selectedId ? memoryNeighborhood(graph, selectedId) : null, [graph, selectedId]);
  const weights = useMemo(() => graph ? graphNodeWeights(graph) : new Map<string, number>(), [graph]);
  const maxWeight = Math.max(1, ...weights.values());
  const selected = focus?.selected ?? null;
  const viewNodes = useMemo(
    () => (focus ? [focus.selected, ...focus.neighbors.map(({ node }) => node)] : graph?.nodes ?? []),
    [graph, focus]
  );
  const shownEdges = focus ? focus.neighbors.map(({ edge }) => edge) : graph?.edges ?? [];
  const drawable = graph !== null && isGraphDrawable(graph);
  /** 闸门句只在画得出图时摆：画不出来时那句「还不是一张图」已经把同一个条数说过了，两句同时出现就是重复。 */
  const gateNote = graph && drawable ? describeAssociationGate(graph.associationGated) : '';
  const needle = query.trim().toLocaleLowerCase();
  const matches = graph?.nodes.filter((node) => node.content.toLocaleLowerCase().includes(needle)) ?? [];
  const picker = graph && graph.nodes.length > 0 ? (
    <div className="min-w-0 rounded-2xl border border-slate-700/70 bg-[#111c2b] p-3">
      <label className="flex items-center gap-2 rounded-xl border border-slate-600 bg-[#0b1420] px-3 text-slate-300 focus-within:border-aurora-400">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
        <input
          type="search"
          aria-label="搜索并聚焦记忆"
          placeholder="搜索记忆…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-400"
        />
      </label>
      <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1 lg:max-h-[360px]">
        <button type="button" aria-pressed={!selected} onClick={() => setSelectedId(null)} className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-700 aria-pressed:bg-emerald-950 aria-pressed:text-emerald-100">
          全部记忆 <span className="text-xs text-slate-300">· {graph.nodes.length}</span>
        </button>
        {matches.map((node) => (
          <button
            key={node.id}
            type="button"
            aria-pressed={selected?.id === node.id}
            onClick={() => setSelectedId(node.id)}
            className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-slate-100 hover:bg-slate-700 aria-pressed:bg-emerald-950 aria-pressed:text-emerald-100"
          >
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: GRAPH_CONTEXT_COLORS[node.context] }} />
            <span className="min-w-0 flex-1 break-words">{truncateNodeLabel(node.content)}</span>
            <span className="shrink-0 text-xs text-slate-300" title="关联数">{weights.get(node.id) ?? 0}</span>
          </button>
        ))}
        {needle && matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-slate-300">没有找到匹配的记忆。</p>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">记忆网络</h2>
          <p className="mt-1 text-[12.5px] text-white/40">
            把已经存在的记忆连起来：谁被谁更新成、哪些是在同一场对话里说的、哪些被同一条洞察一起提到过。连线全部从库里的真实关系推导，不猜。
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-white/70">
          <input
            type="checkbox"
            checked={enabled === true}
            disabled={enabled === null || flagBusy}
            onChange={() => void toggleEnabled()}
            className="accent-emerald-400"
          />
          {enabled === null ? '开关状态未知' : enabled ? '已打开' : '已关闭'}
        </label>
      </div>

      {enabled === false ? (
        <Alert tone="info" className="mt-4">
          关闭时这一屏不读取你的记忆。打开后才会连出这张图。
        </Alert>
      ) : null}

      {enabled === true ? (
        <div className="mt-5 space-y-3">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {graph ? describeGraphBudget(graph).map((sentence) => <Alert key={sentence} tone="info">{sentence}</Alert>) : null}
          {gateNote ? <Alert tone="info">{gateNote}</Alert> : null}
          {loading ? (
            <LoadingBlock label="加载记忆网络" />
          ) : graph === null ? null : drawable ? (
            <div className="space-y-3">
              <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
                <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-700/70 bg-[#0b1420]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/70 px-4 py-3 text-xs text-slate-300">
                    <span className="font-medium text-slate-100">{focus ? '直接关系' : '网络总览'} · 3D 星图</span>
                    <span>{viewNodes.length} 条记忆 · {shownEdges.length} 条关系</span>
                  </div>
                  <div className="p-3">
                    <MemoryStarfield
                      nodes={viewNodes.map((node) => ({
                        id: node.id,
                        content: node.content,
                        context: node.context,
                        isCurrent: node.isCurrent,
                        weight: weights.get(node.id) ?? 0
                      }))}
                      edges={shownEdges}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      maxWeight={maxWeight}
                    />
                  </div>
                </div>
                {picker}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-white/45">
                {Object.entries(GRAPH_EDGE_LABELS).map(([kind, label]) => (
                  <span key={kind} className="inline-flex items-center gap-1.5">
                    <svg viewBox="0 0 26 6" className="h-[6px] w-[26px]">
                      <line
                        x1="0"
                        y1="3"
                        x2="26"
                        y2="3"
                        stroke={STAR_EDGE_COLORS[kind as GraphEdgeKind]}
                        strokeDasharray={STAR_EDGE_DASHES[kind as GraphEdgeKind].join(' ') || undefined}
                        strokeWidth={1.4}
                      />
                    </svg>
                    {label}
                  </span>
                ))}
                {graph.groups.map((group) => (
                  <span key={group.context} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: GRAPH_CONTEXT_COLORS[group.context] }}
                    />
                    {CONTEXT_LABELS[group.context]} {group.nodeIds.length}
                  </span>
                ))}
              </div>

              <p className="text-xs leading-relaxed text-slate-300">连接越多，星点越亮、越大。3D 坐标只为了铺开并按主题聚簇，不表示真实距离；点击星点聚焦，自动旋转可开关。选中一点后，只显示和它直接相连的记忆。</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Alert tone="info">{describeNotAGraph(graph.nodes.length, graph.edges.length, graph.associationGated)}</Alert>
              {picker}
              {!selected ? graph.nodes.map((node) => (
                <button key={node.id} type="button" onClick={() => setSelectedId(node.id)} className="block w-full whitespace-pre-wrap break-words rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-left text-[13px] leading-relaxed text-white/80">
                  <span className="block">{node.content}</span>
                  <span className="mt-1 block text-[11px] text-white/55">
                    {CONTEXT_LABELS[node.context]}{node.isCurrent ? '' : ' · 已被新说法取代'}
                  </span>
                </button>
              )) : null}
              {graph.nodes.length === 0 ? (
                <EmptyState
                  icon={<Share2 className="h-5 w-5" />}
                  title="还没有可连的记忆"
                  description="你在对话里说过的信息会先进入「记忆」，连得上的关系才会出现在这张图上。"
                />
              ) : null}
            </div>
          )}
          {!loading && focus && selected ? (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                {selected.content}
              </p>
              <p className="mt-2 flex flex-wrap gap-1.5">
                <span className="chip !px-2 !py-0.5 !text-[10.5px]">{TYPE_LABELS[selected.type]}</span>
                <span className="chip !px-2 !py-0.5 !text-[10.5px]">{CONTEXT_LABELS[selected.context]}</span>
                {selected.isCurrent ? null : (
                  <span className="badge badge-amber !px-2 !py-0.5 !text-[10.5px]">已被新说法取代</span>
                )}
              </p>
              {selected.chatId ? (
                <p className="mt-2 text-[11.5px] text-white/40">
                  {chats[selected.chatId] ? (
                    <Link
                      href={`/chat/${encodeURIComponent(selected.chatId)}`}
                      className="inline-block max-w-[260px] truncate align-bottom text-white/45 underline-offset-2 hover:text-white/80 hover:underline"
                    >
                      来自：{chats[selected.chatId]}
                    </Link>
                  ) : (
                    <span>来自：原对话已删除</span>
                  )}
                </p>
              ) : null}
              <div className="mt-4 border-t border-white/[0.07] pt-3">
                <h3 className="text-[13px] font-medium text-white">当前视图中的直接关系（{focus.neighbors.length}）</h3>
                {focus.neighbors.length === 0 ? (
                  <p className="mt-2 text-[12px] text-white/55">当前视图中没有连到这条记忆的线。</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {focus.neighbors.map(({ node, label }) => (
                      <li key={node.id}>
                        <button type="button" className="w-full rounded-lg bg-white/[0.04] p-2.5 text-left hover:bg-white/[0.08]" onClick={() => setSelectedId(node.id)}>
                          <span className="block text-[11px] text-white/55">{label}</span>
                          <span className="block break-words text-[13px] text-white/85">{node.content}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
