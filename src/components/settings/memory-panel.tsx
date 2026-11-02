'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Brain, History, Pencil, Scale, Trash2, X } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, Spinner, useConfirm, useToast } from '@/components/ui';
import {
  CONFIDENCE_BAND_LABELS,
  CONTEXT_LABELS,
  ORIGIN_LABELS,
  REVISION_ACTION_LABELS,
  TYPE_LABELS,
  describeConfidenceFactor,
  describeValidRange
} from '@/lib/cognitive/memory-display';
import type { MemoryDto, MemoryRevisionDto } from '@/lib/cognitive/memories';
import type { ExclusionDto } from '@/lib/cognitive/exclusions';
import type { EvidenceDto } from '@/lib/cognitive/evidence';
import type { ConfidenceBand, ConfidenceFactor } from '@/lib/cognitive/confidence';

/**
 * 记忆管理那一屏：看到系统记住了什么，并逐条更正、撤回、永久删除。
 *
 * 三条约束决定了这里的形状：
 * 一、一屏只有一个展开区。列表行上五个按钮——更正 / 撤回 / 版本 / 证据 / 永久删除——
 *    各自打开自己的表单，同时只开一个，否则页面上会堆出好几套输入框，
 *    谁也说不清哪套是当前要提交的。
 * 二、版本链点一次往前取一版。服务端的边只回答「这一版是怎么来的」，
 *    所以全链要一格一格走，不该在这里假设链很短就一次拉完。
 * 三、撤回和永久删除是两个动作，都留着：撤回是可逆的「不再使用」，正文仍在库里；
 *    永久删除是不可逆的「这条从来没存在过」。界面上必须能看出这两者的区别。
 * 四、永久删除过的内容会进排除表，不会被自动记回来。那张表必须看得见、撤得掉，
 *    否则就成了一条没有任何入口能解开的静默封禁——用户只会发现 AI 再也记不住某些话。
 */

interface ChainEntry {
  memory: MemoryDto;
  revisions: MemoryRevisionDto[];
}

type Panel = { kind: 'edit' | 'retract' | 'history' | 'purge' | 'evidence'; id: string } | null;

/** 置信度旁表：只有档位和因子，分数不出服务端。 */
interface ConfidenceEntry {
  band: ConfidenceBand;
  factors: ConfidenceFactor[];
}

const BAND_BADGE: Record<ConfidenceBand, string> = {
  high: 'badge badge-green !px-2 !py-0.5 !text-[10.5px]',
  medium: 'chip !px-2 !py-0.5 !text-[10.5px]',
  low: 'badge badge-amber !px-2 !py-0.5 !text-[10.5px]'
};

const CONTENT_MAX = 1000;
const REASON_MAX = 500;

export function MemoryPanel() {
  const { push } = useToast();
  const { confirm } = useConfirm();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [chats, setChats] = useState<Record<string, string>>({});
  const [confidence, setConfidence] = useState<Record<string, ConfidenceEntry>>({});
  const [evidence, setEvidence] = useState<EvidenceDto[]>([]);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exclusions, setExclusions] = useState<ExclusionDto[]>([]);
  const [exclusionsError, setExclusionsError] = useState('');
  const [removingId, setRemovingId] = useState('');

  const [panel, setPanel] = useState<Panel>(null);
  const [chain, setChain] = useState<ChainEntry[]>([]);
  const [chainBusy, setChainBusy] = useState(false);

  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const [busyId, setBusyId] = useState('');
  /** 批量删除的忙碌标记：'all' 或 'chat:<id>'，和单条用的 busyId 分开，免得互相禁用。 */
  const [bulkBusy, setBulkBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{
        memories: MemoryDto[];
        chats: Record<string, string>;
        confidence: Record<string, ConfidenceEntry>;
      }>('/api/account/cognitive/memories');
      setMemories(data.memories);
      setChats(data.chats);
      setConfidence(data.confidence ?? {});
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 排除表单独读：它读不出来时记忆列表照样要能看，两件事不该互相拖住。 */
  const loadExclusions = useCallback(async () => {
    try {
      const data = await apiFetch<{ exclusions: ExclusionDto[] }>('/api/account/cognitive/exclusions');
      setExclusions(data.exclusions);
      setExclusionsError('');
    } catch (err) {
      setExclusionsError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadExclusions();
    void (async () => {
      try {
        const data = await apiFetch<{ preferences: { memoryEnabled: boolean } }>('/api/account/cognitive');
        setEnabled(data.preferences.memoryEnabled);
      } catch {
        // 开关读不到就保持 null：界面显示「状态未知」，而不是假装它是关着的。
      }
    })();
  }, [load, loadExclusions]);

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
    setEvidence([]);
    setDraft('');
    setReason('');
    setFormError('');
  }

  /** 再点同一个按钮收起；点别的按钮就换到那一栏——同时只有一个展开区。 */
  function reopen(kind: 'edit' | 'retract' | 'history' | 'purge' | 'evidence', memory: MemoryDto) {
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

  /** 证据和版本链一样，点一次取一条记忆的：说明文字是密文，不该为没人看的行白解一遍。 */
  async function openEvidence(memory: MemoryDto) {
    if (!reopen('evidence', memory)) return;
    setEvidenceBusy(true);
    try {
      const data = await apiFetch<{ evidence: EvidenceDto[] }>(
        `/api/account/cognitive/memories/${encodeURIComponent(memory.id)}/evidence`
      );
      setEvidence(data.evidence);
    } catch (err) {
      push(errorMessage(err), 'error');
      setPanel(null);
    } finally {
      setEvidenceBusy(false);
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

  /** 永久删除一条。不可逆，所以走的是行内展开区 + 明说不可恢复，不给「一键删掉」的顺手路径。 */
  async function submitPurge(memory: MemoryDto) {
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE' });
      push('已永久删除');
      close();
      await Promise.all([load(), loadExclusions()]);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  /**
   * 忘记某次对话产生的全部记忆，对话本身保留。
   * 确认框里不报条数：列表只有当前有效的那些，被取代过的和已撤回的行也在删除范围内，
   * 客户端数出来的数字会偏小——不可逆的操作宁可少说，等删完再报服务端返回的真实条数。
   */
  async function purgeByChat(memory: MemoryDto) {
    const chatId = memory.chatId;
    if (!chatId || bulkBusy) return;
    const ok = await confirm({
      title: '忘记这次对话产生的记忆？',
      description: '这次对话产生的记忆会一起删掉，不可恢复。对话本身保留。',
      confirmText: '删除记忆',
      tone: 'danger'
    });
    if (!ok) return;
    setBulkBusy(`chat:${chatId}`);
    try {
      const data = await apiFetch<{ purged: number }>(
        `/api/account/cognitive/memories?scope=chat&chatId=${encodeURIComponent(chatId)}`,
        { method: 'DELETE' }
      );
      push(`已删除 ${data.purged} 条记忆`);
      close();
      await Promise.all([load(), loadExclusions()]);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBulkBusy('');
    }
  }

  async function purgeAll() {
    if (bulkBusy) return;
    const ok = await confirm({
      title: '清空全部长期记忆？',
      description: '删掉系统记住的所有内容，不可恢复。对话记录、附件和账号都不动。',
      confirmText: '清空',
      tone: 'danger'
    });
    if (!ok) return;
    setBulkBusy('all');
    try {
      const data = await apiFetch<{ purged: number }>('/api/account/cognitive/memories?scope=all', {
        method: 'DELETE'
      });
      push(`已清空 ${data.purged} 条记忆`);
      close();
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBulkBusy('');
    }
  }

  async function cancelExclusion(id: string) {
    if (removingId) return;
    setRemovingId(id);
    try {
      await apiFetch(`/api/account/cognitive/exclusions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      push('已撤销，之后可以重新记住');
      await loadExclusions();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setRemovingId('');
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
            const isPurge = panel?.kind === 'purge' && panel.id === memory.id;
            const isEvidence = panel?.kind === 'evidence' && panel.id === memory.id;
            const band = confidence[memory.id]?.band;
            const chatPurgeBusy = bulkBusy === `chat:${memory.chatId}`;
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
                      {/* 算不出档位就不挂标签：这张表是后加的，老记忆可能还没有账可查。 */}
                      {band ? (
                        <span className={BAND_BADGE[band]}>{CONFIDENCE_BAND_LABELS[band]}</span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-white/30">
                      <span>记于 {timeAgo(memory.recordedAt)}</span>
                      {memory.chatId ? (
                        chats[memory.chatId] ? (
                          <Link
                            href={`/chat/${encodeURIComponent(memory.chatId)}`}
                            className="inline-block max-w-[260px] truncate align-bottom text-white/45 underline-offset-2 hover:text-white/80 hover:underline"
                          >
                            来自：{chats[memory.chatId]}
                          </Link>
                        ) : (
                          <span>来自：原对话已删除</span>
                        )
                      ) : null}
                      {/* 原对话已经不在了就不给这个入口：确认文案说「对话本身保留」，那时会是假话。 */}
                      {memory.chatId && chats[memory.chatId] ? (
                        <button
                          type="button"
                          className="text-white/35 underline-offset-2 hover:text-red-300 hover:underline disabled:cursor-not-allowed disabled:opacity-45"
                          disabled={Boolean(bulkBusy)}
                          onClick={() => void purgeByChat(memory)}
                        >
                          {chatPurgeBusy ? '删除中…' : '忘记这次对话产生的记忆'}
                        </button>
                      ) : null}
                    </div>
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
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => void openEvidence(memory)}
                    >
                      <Scale className="h-3.5 w-3.5" /> 证据
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px] hover:text-red-300"
                      onClick={() => reopen('purge', memory)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 永久删除
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

                {isEvidence ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div className="text-[12.5px] font-medium text-white/70">支持与反对的证据</div>
                    <p className="text-[11.5px] text-white/35">
                      证据只回答「这条记忆凭什么在这里」，不改变它的内容。
                    </p>
                    {(confidence[memory.id]?.factors ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {(confidence[memory.id]?.factors ?? []).map((factor, index) => (
                          <span key={index} className="chip !px-2 !py-0.5 !text-[10.5px]">
                            {describeConfidenceFactor(factor)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {evidenceBusy ? (
                      <LoadingBlock label="加载证据" />
                    ) : evidence.length === 0 ? (
                      <p className="text-[12px] text-white/40">
                        没有额外证据：这条记忆只有它自己那一次陈述。
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {evidence.map((entry) => (
                          <li key={entry.id} className="text-[11.5px] text-white/45">
                            {entry.kind === 'supports' ? '支持' : '反对'} ·{' '}
                            {describeConfidenceFactor({ kind: 'origin', origin: entry.origin })} ·{' '}
                            {timeAgo(entry.createdAt)}
                            {entry.note ? <span className="block text-white/35">{entry.note}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                {isPurge ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <p className="text-[12.5px] leading-relaxed text-white/60">
                      这条记忆和它的历史版本会一起从数据库里删掉，不可恢复。原对话记录不动。
                    </p>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-danger !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitPurge(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />} 确认永久删除
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* 空表时整块不渲染：没有排除项却摆一段解释，只会让人以为系统在瞒着什么。 */}
      {exclusions.length > 0 ? (
        <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <h3 className="text-[13.5px] font-medium text-white/85">不再自动记住的内容</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            你永久删除过的内容不会被自动记回来。要允许它重新被记住，点「撤销」。
          </p>
          {exclusionsError ? (
            <Alert tone="error" className="mt-3">
              {exclusionsError}
            </Alert>
          ) : null}
          <ul className="mt-3 space-y-2.5">
            {exclusions.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[12.5px] text-white/70">{entry.content}</span>
                  <span className="mt-0.5 block text-[11px] text-white/30">排除于 {timeAgo(entry.createdAt)}</span>
                </span>
                <button
                  type="button"
                  className="btn-ghost shrink-0 !px-2.5 !py-1 !text-[12px]"
                  disabled={removingId === entry.id}
                  onClick={() => void cancelExclusion(entry.id)}
                >
                  {removingId === entry.id ? <Spinner /> : null} 撤销
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 一条记忆都没有时不放这个按钮：一个「清空全部」的空控件只会让人怀疑它到底删了什么。 */}
      {memories.length > 0 ? (
        <div className="mt-6 rounded-xl border border-red-400/20 bg-red-400/[0.04] p-4">
          <h3 className="text-[13.5px] font-medium text-red-200">清空全部长期记忆</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            删掉系统记住的所有内容，不可恢复。对话记录、附件和账号都不动。
          </p>
          <button
            type="button"
            className="btn-danger !mt-3 !px-3 !py-1.5 !text-[12px]"
            disabled={Boolean(bulkBusy)}
            onClick={() => void purgeAll()}
          >
            {bulkBusy === 'all' ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />} 清空全部长期记忆
          </button>
        </div>
      ) : null}
    </section>
  );
}
