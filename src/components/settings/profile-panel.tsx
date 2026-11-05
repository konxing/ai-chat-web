'use client';

import { useCallback, useEffect, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, Spinner, useConfirm, useToast } from '@/components/ui';
import {
  PROFILE_EDITED_LABEL,
  describeConfirmedAt,
  describeEntrySources,
  describeProfileCap
} from '@/lib/cognitive/user-profile-display';

/**
 * 「用户画像」那一屏（任务书 8.2 / 8.3 的界面）。
 *
 * 形状由后端定，三处硬约束：
 * 一、闸门先行。这一屏读的是密文，`userModelEnabled` 没打开时连一个请求都不发——和洞察、时间线同一个口径。
 * 二、候选和条目是两个区，不是一条列表。候选**一行都没进库**，点「收进画像」之前它只是服务端现算出来的提议；
 *    条目是点过那一下之后存下来的。两边的措辞必须让这两种东西一眼能分开，
 *    所以候选那一行原样显示服务端带来的标注（词表常量），界面一个字都不改写。
 * 三、条目只有「改正文」和「删」，没有「改依据」。那两份 id 记的是**你确认那一刻的依据**，
 *    事后能换就等于「我当时是怎么确认的」可以被改写（user-profile.ts 文件头）。
 *
 * 「清空全部画像」和「清空全部长期记忆」是两个动作，中间那句话必须说出来：
 * 画像是你确认过的东西，不跟着记忆的忘记路径走，反过来也不该被读成「把系统关于我的一切都抹掉」。
 *
 * 错误文案一律直接显示服务端那句话：409/429/400 的话术在服务层和路由里各写过一遍，
 * 前端再抄一份就是第三套，迟早分叉。
 */
const PROFILE_URL = '/api/account/cognitive/profile';
const PREFERENCES_URL = '/api/account/cognitive';
const entryUrl = (id: string) => `${PROFILE_URL}/${encodeURIComponent(id)}`;

interface EntryDto {
  id: string;
  content: string;
  sourceMemoryIds: string[];
  sourceReflectionIds: string[];
  confirmedAt: string;
  editedAt: string | null;
}

interface CandidateDto {
  from: 'memory' | 'reflection';
  content: string;
  note: string;
  sourceMemoryIds: string[];
  sourceReflectionIds: string[];
}

export function ProfilePanel() {
  const { push } = useToast();
  const { confirm } = useConfirm();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [entries, setEntries] = useState<EntryDto[]>([]);
  const [candidates, setCandidates] = useState<CandidateDto[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [draft, setDraft] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [clearBusy, setClearBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ entries: EntryDto[]; entriesCapped: boolean; candidates: CandidateDto[] }>(
        PROFILE_URL
      );
      setEntries(data.entries);
      setCandidates(data.candidates);
      setCapped(data.entriesCapped);
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
        const data = await apiFetch<{ preferences: { userModelEnabled: boolean } }>(PREFERENCES_URL);
        setEnabled(data.preferences.userModelEnabled);
      } catch {
        // 开关读不到就保持 null：界面显示「开关状态未知」，而不是假装它是关着的。
      }
    })();
  }, []);

  useEffect(() => {
    if (enabled === true) void load();
  }, [enabled, load]);

  async function toggleEnabled() {
    if (enabled === null || flagBusy) return;
    setFlagBusy(true);
    try {
      const data = await apiFetch<{ preferences: { userModelEnabled: boolean } }>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { userModelEnabled: !enabled }
      });
      setEnabled(data.preferences.userModelEnabled);
      push(data.preferences.userModelEnabled ? '画像已打开' : '画像已关闭');
      if (data.preferences.userModelEnabled) await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  /** 确认候选：正文和那两份来源 id 一起递上去，确认时间由服务在这一刻盖。 */
  async function accept(candidate: CandidateDto) {
    if (busyId) return;
    setBusyId(candidate.content);
    try {
      await apiFetch(PROFILE_URL, {
        method: 'POST',
        json: { content: candidate.content, sourceMemoryIds: candidate.sourceMemoryIds, sourceReflectionIds: candidate.sourceReflectionIds }
      });
      push('已收进画像。');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  /** 亲笔写一条：没有来源，因为「依据」这一栏在没有系统提议时本来就该是空的。 */
  async function writeOwn() {
    const content = draft.trim();
    if (!content || draftBusy) return;
    setDraftBusy(true);
    try {
      await apiFetch(PROFILE_URL, { method: 'POST', json: { content } });
      setDraft('');
      push('已写下这条。');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setDraftBusy(false);
    }
  }

  async function revise(entry: EntryDto) {
    const content = editValue.trim();
    if (!content || busyId) return;
    setBusyId(entry.id);
    try {
      await apiFetch(entryUrl(entry.id), { method: 'PATCH', json: { content } });
      setEditingId(null);
      push('已改过这条。');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  async function remove(entry: EntryDto) {
    if (busyId) return;
    const ok = await confirm({
      title: '删除这条画像？',
      description: '只删这一条你确认过的画像条目，不可恢复。你的记忆、对话和洞察都不动。',
      confirmText: '删除',
      tone: 'danger'
    });
    if (!ok) return;
    setBusyId(entry.id);
    try {
      await apiFetch(entryUrl(entry.id), { method: 'DELETE' });
      push('已删除这条画像。');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  async function clearAll() {
    if (clearBusy) return;
    const ok = await confirm({
      title: '清空全部画像？',
      description: '删掉你确认过的全部画像条目，不可恢复。长期记忆、对话和洞察都不动。',
      confirmText: '清空',
      tone: 'danger'
    });
    if (!ok) return;
    setClearBusy(true);
    try {
      await apiFetch(PROFILE_URL, { method: 'DELETE' });
      push('已清空画像，你的记忆一条都没动。');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setClearBusy(false);
    }
  }

  // 服务端读满 200 行才算截断；这句必须说出来，否则「这里没有更早的」会被读成「更早的没发生过」。
  const capNote = describeProfileCap(capped, entries.length);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">用户画像</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-white/40">
            开启后，系统会把你说过或确认过的记忆、你采纳过的洞察整理成候选摆在这里；只有你点过「收进画像」的才会存下来。
            对话时最多带最近 6 条给模型，模型不会把这里没写到的特质当成知道的事。
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
          用户画像没有打开
        </Alert>
      ) : null}

      {enabled === true ? (
        <div className="mt-5 space-y-5">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {capNote ? <Alert tone="info">{capNote}</Alert> : null}

          <div className="flex flex-wrap items-start gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={2}
              placeholder="比如：我习惯先把事写完再聊"
              className="min-h-[52px] flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] leading-relaxed text-white/85 outline-none placeholder:text-white/25 focus:border-emerald-400/40"
            />
            <button
              type="button"
              className="btn-ghost !px-3 !py-2 !text-[12.5px]"
              disabled={draftBusy || !draft.trim()}
              onClick={() => void writeOwn()}
            >
              {draftBusy ? <Spinner /> : null} 写下这条
            </button>
            <button
              type="button"
              className="btn-ghost !px-3 !py-2 !text-[12.5px] hover:text-red-300"
              disabled={clearBusy || entries.length === 0}
              onClick={() => void clearAll()}
            >
              {clearBusy ? <Spinner /> : null} 清空全部画像
            </button>
          </div>

          {loading ? (
            <LoadingBlock label="加载画像" />
          ) : (
            <>
              <div>
                <h3 className="mb-2 text-[12px] font-medium text-white/45">
                  待你确认的候选（{candidates.length}）
                </h3>
                {candidates.length === 0 ? (
                  <p className="text-[12.5px] leading-relaxed text-white/40">
                    没有候选。系统只在你的记忆攒够依据时才提出，凑不满就不提。
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {candidates.map((candidate, index) => (
                      <div
                        key={`${candidate.from}:${index}`}
                        className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
                      >
                        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                          {candidate.content}
                        </p>
                        <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">{candidate.note}</p>
                        <div className="mt-2.5">
                          <button
                            type="button"
                            className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                            disabled={busyId === candidate.content}
                            onClick={() => void accept(candidate)}
                          >
                            {busyId === candidate.content ? <Spinner /> : null} 收进画像
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-[12px] font-medium text-white/45">
                  你确认过的画像（{entries.length}）
                </h3>
                {entries.length === 0 ? (
                  <EmptyState
                    icon={<Fingerprint className="h-5 w-5" />}
                    title="画像还是空的"
                    description="你可以自己写一条，也可以等系统摆出候选后由你确认。"
                  />
                ) : (
                  <div className="space-y-2.5">
                    {entries.map((entry) => {
                      const sources = describeEntrySources(entry.sourceMemoryIds, entry.sourceReflectionIds);
                      const isEditing = editingId === entry.id;
                      return (
                        <div
                          key={entry.id}
                          className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
                        >
                          {isEditing ? (
                            <textarea
                              value={editValue}
                              onChange={(event) => setEditValue(event.target.value)}
                              rows={3}
                              className="min-h-[68px] w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] leading-relaxed text-white/85 outline-none focus:border-emerald-400/40"
                            />
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                              {entry.content}
                              {entry.editedAt ? PROFILE_EDITED_LABEL : ''}
                            </p>
                          )}
                          <p className="mt-1 text-[11.5px] text-white/35">
                            {describeConfirmedAt(entry.confirmedAt)}
                            {sources ? ` · ${sources}` : ''}
                          </p>

                          <div className="mt-2.5 flex flex-wrap items-center gap-2">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                  disabled={busyId === entry.id || !editValue.trim()}
                                  onClick={() => void revise(entry)}
                                >
                                  {busyId === entry.id ? <Spinner /> : null} 保存
                                </button>
                                <button
                                  type="button"
                                  className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                  onClick={() => setEditingId(null)}
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                  onClick={() => {
                                    setBusyId('');
                                    setEditingId(entry.id);
                                    setEditValue(entry.content);
                                  }}
                                >
                                  改正文
                                </button>
                                <button
                                  type="button"
                                  className="btn-ghost !px-2.5 !py-1.5 !text-[12px] hover:text-red-300"
                                  disabled={busyId === entry.id}
                                  onClick={() => void remove(entry)}
                                >
                                  删除
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
