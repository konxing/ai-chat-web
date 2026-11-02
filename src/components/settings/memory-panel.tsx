'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain, History, Pencil, X } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, Spinner, useToast } from '@/components/ui';
import {
  CONTEXT_LABELS,
  ORIGIN_LABELS,
  REVISION_ACTION_LABELS,
  TYPE_LABELS,
  describeValidRange
} from '@/lib/cognitive/memory-display';
import type { MemoryDto, MemoryRevisionDto } from '@/lib/cognitive/memories';

/**
 * 记忆管理那一屏：看到系统记住了什么，并逐条更正、撤回。
 *
 * 三条约束决定了这里的形状：
 * 一、一屏只有一个展开区。列表行上三个按钮——更正 / 撤回 / 版本——各自打开自己的表单，
 *    同时只开一个，否则页面上会堆出好几套输入框，谁也说不清哪套是当前要提交的。
 * 二、版本链点一次往前取一版。服务端的边只回答「这一版是怎么来的」，
 *    所以全链要一格一格走，不该在这里假设链很短就一次拉完。
 * 三、撤回必须写理由，按钮写「撤回」而不是「删除」——数据没有消失，只是不再被使用。
 */

interface ChainEntry {
  memory: MemoryDto;
  revisions: MemoryRevisionDto[];
}

type Panel = { kind: 'edit' | 'retract' | 'history'; id: string } | null;

const CONTENT_MAX = 1000;
const REASON_MAX = 500;

export function MemoryPanel() {
  const { push } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [panel, setPanel] = useState<Panel>(null);
  const [chain, setChain] = useState<ChainEntry[]>([]);
  const [chainBusy, setChainBusy] = useState(false);

  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ memories: MemoryDto[] }>('/api/account/cognitive/memories');
      setMemories(data.memories);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void (async () => {
      try {
        const data = await apiFetch<{ preferences: { memoryEnabled: boolean } }>('/api/account/cognitive');
        setEnabled(data.preferences.memoryEnabled);
      } catch {
        // 开关读不到就保持 null：界面显示「状态未知」，而不是假装它是关着的。
      }
    })();
  }, [load]);

  async function toggleEnabled() {
    if (enabled === null || flagBusy) return;
    setFlagBusy(true);
    try {
      const data = await apiFetch<{ preferences: { memoryEnabled: boolean } }>('/api/account/cognitive', {
        method: 'PATCH',
        json: { memoryEnabled: !enabled }
      });
      setEnabled(data.preferences.memoryEnabled);
      push(data.preferences.memoryEnabled ? '长期记忆已打开' : '长期记忆已关闭');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  function close() {
    setPanel(null);
    setChain([]);
    setDraft('');
    setReason('');
    setFormError('');
  }

  /** 再点同一个按钮收起；点别的按钮就换到那一栏——同时只有一个展开区。 */
  function reopen(kind: 'edit' | 'retract' | 'history', memory: MemoryDto) {
    if (panel && panel.kind === kind && panel.id === memory.id) {
      close();
      return false;
    }
    close();
    setPanel({ kind, id: memory.id });
    return true;
  }

  async function openHistory(memory: MemoryDto) {
    if (!reopen('history', memory)) return;
    setChainBusy(true);
    try {
      const data = await apiFetch<ChainEntry>(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}`);
      setChain([data]);
    } catch (err) {
      push(errorMessage(err), 'error');
      setPanel(null);
    } finally {
      setChainBusy(false);
    }
  }

  async function loadPrevious(entry: ChainEntry) {
    const previousId = entry.revisions.find((edge) => edge.previousId)?.previousId;
    if (!previousId) return;
    setChainBusy(true);
    try {
      const data = await apiFetch<ChainEntry>(
        `/api/account/cognitive/memories/${encodeURIComponent(previousId)}`
      );
      setChain((current) => [...current, data]);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setChainBusy(false);
    }
  }

  function startEdit(memory: MemoryDto) {
    if (!reopen('edit', memory)) return;
    setDraft(memory.content);
  }

  async function submitEdit(memory: MemoryDto) {
    if (!draft.trim()) {
      setFormError('记忆正文不能为空');
      return;
    }
    if (!reason.trim()) {
      setFormError('改记忆要写明理由');
      return;
    }
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}`, {
        method: 'PATCH',
        json: { content: draft, reason }
      });
      push('已按新说法更新，旧版本仍保留');
      close();
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  async function submitRetract(memory: MemoryDto) {
    if (!reason.trim()) {
      setFormError('撤回记忆要写明理由');
      return;
    }
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}/retract`, {
        method: 'POST',
        json: { reason }
      });
      push('已撤回，这条不再用于对话');
      close();
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">长期记忆</h2>
          <p className="mt-1 text-[12.5px] text-white/40">
            下面是系统关于你记住的内容。更正会留下旧版本，撤回只是不再使用，两种操作都要写理由。
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-white/70">
          <input
            type="checkbox"
            checked={enabled === true}
            disabled={enabled === null || flagBusy}
            onChange={toggleEnabled}
            className="accent-emerald-400"
          />
          {enabled === null ? '开关状态未知' : enabled ? '已打开' : '已关闭'}
        </label>
      </div>
      {enabled === false ? (
        <Alert tone="info" className="mt-4">
          关闭只停止新的读写，已存下的记忆仍在下面这份列表里。要逐条停掉，用「撤回」。
        </Alert>
      ) : null}

      <div className="mt-5 space-y-2.5">
        {loadError ? <Alert tone="error">{loadError}</Alert> : null}
        {loading ? (
          <LoadingBlock label="加载记忆" />
        ) : memories.length === 0 ? (
          <EmptyState
            icon={<Brain className="h-5 w-5" />}
            title="还没有记住的内容"
            description="打开长期记忆后，你在对话里明确说过的信息会出现在这里。"
          />
        ) : (
          memories.map((memory) => {
            const isEdit = panel?.kind === 'edit' && panel.id === memory.id;
            const isRetract = panel?.kind === 'retract' && panel.id === memory.id;
            const isHistory = panel?.kind === 'history' && panel.id === memory.id;
            return (
              <div key={memory.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                      {memory.content}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="chip !px-2 !py-0.5 !text-[10.5px]">{TYPE_LABELS[memory.type]}</span>
                      <span className="chip !px-2 !py-0.5 !text-[10.5px]">{CONTEXT_LABELS[memory.context]}</span>
                      <span
                        className={
                          memory.origin === 'inferred' || memory.origin === 'hypothesis'
                            ? 'badge badge-amber !px-2 !py-0.5 !text-[10.5px]'
                            : 'chip !px-2 !py-0.5 !text-[10.5px]'
                        }
                      >
                        {ORIGIN_LABELS[memory.origin]}
                      </span>
                      {/* 抽取器存的都是「时间未知」，每条都挂这个标签就成了噪音；只在真有时间信息时显示。 */}
                      {memory.precision !== 'unknown' && memory.validFrom ? (
                        <span className="chip !px-2 !py-0.5 !text-[10.5px]">{describeValidRange(memory)}</span>
                      ) : null}
                      {memory.version > 1 ? (
                        <span className="chip !px-2 !py-0.5 !text-[10.5px]">第 {memory.version} 版</span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 text-[11.5px] text-white/30">记于 {timeAgo(memory.recordedAt)}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => startEdit(memory)}
                    >
                      <Pencil className="h-3.5 w-3.5" /> 更正
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => reopen('retract', memory)}
                    >
                      <X className="h-3.5 w-3.5" /> 撤回
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => void openHistory(memory)}
                    >
                      <History className="h-3.5 w-3.5" /> 版本
                    </button>
                  </div>
                </div>

                {isEdit ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div>
                      <label className="label">新的说法</label>
                      <textarea
                        className="field min-h-[88px]"
                        maxLength={CONTENT_MAX}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="label">为什么改</label>
                      <input
                        className="field"
                        maxLength={REASON_MAX}
                        placeholder="例如：项目已经换到 PostgreSQL"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitEdit(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : null} 保存新版本
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {isRetract ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div>
                      <label className="label">撤回理由</label>
                      <input
                        className="field"
                        maxLength={REASON_MAX}
                        placeholder="例如：这已经不是我的情况"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>
                    <p className="text-[11.5px] text-white/35">撤回后这条不再进入对话，也不会再被更新。</p>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-danger !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitRetract(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : <X className="h-3.5 w-3.5" />} 确认撤回
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {isHistory ? (
                  <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
                    {chainBusy && chain.length === 0 ? <LoadingBlock label="加载版本链" /> : null}
                    {chain.map((entry, index) => {
                      const previousId = entry.revisions.find((edge) => edge.previousId)?.previousId;
                      return (
                        <div key={entry.memory.id} className="space-y-1.5">
                          <div className="text-[11.5px] text-white/35">
                            第 {entry.memory.version} 版 · {timeAgo(entry.memory.recordedAt)}
                            {index === 0 ? '' : ' · 已被取代'}
                          </div>
                          <div className="whitespace-pre-wrap break-words text-[13px] text-white/70">
                            {entry.memory.content}
                          </div>
                          {entry.revisions.map((revision) => (
                            <div key={revision.id} className="text-[11.5px] text-white/40">
                              {REVISION_ACTION_LABELS[revision.action]}：{revision.reason} ·{' '}
                              {timeAgo(revision.createdAt)}
                            </div>
                          ))}
                          {previousId ? (
                            <button
                              type="button"
                              className="btn-ghost !px-2.5 !py-1 !text-[12px]"
                              disabled={chainBusy}
                              onClick={() => void loadPrevious(entry)}
                            >
                              {chainBusy ? <Spinner /> : null} 上一版
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
