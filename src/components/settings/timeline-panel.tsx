'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, History } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { Alert, EmptyState, LoadingBlock, useToast } from '@/components/ui';
import {
  CONTEXT_LABELS,
  ORIGIN_LABELS,
  TYPE_LABELS,
  TYPE_ORDER,
  describeValidRange
} from '@/lib/cognitive/memory-display';
import type { MemoryType } from '@/lib/cognitive/policy';
import type { TimelineEvent } from '@/lib/cognitive/timeline';

/**
 * 认知时间线那一屏（任务书 4.4 的读侧界面）。
 *
 * 三条形状不是审美选择，是后端和任务书直接落下来的：
 * 一、开关放在界面上，闸门留在服务端。关着时这一屏连请求都不发（省一趟解密），
 *    而接口自己照样 409——界面上的「关」不是唯一那道闸，绕过去也读不到东西。
 * 二、时间有两种说法，不许混。`validity` 是用户说过的事情发生的时间，
 *    `recorded` 只是系统把它记下来的时刻；4.2 禁止后者冒充前者，
 *    所以退到记录时间的那一条必须挂上「发生时间未知」。
 * 三、旧版本在这里只给计数，版本链的浏览留在「记忆」那一屏——同一个动作不做两个入口。
 */

const TIMELINE_URL = '/api/account/cognitive/timeline';
const PREFERENCES_URL = '/api/account/cognitive';

type Filter = MemoryType | 'all';

export function TimelinePanel() {
  const { push } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [chats, setChats] = useState<Record<string, string>>({});
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{
        events: TimelineEvent[];
        chats: Record<string, string>;
        capped: boolean;
      }>(TIMELINE_URL);
      setEvents(data.events);
      setChats(data.chats);
      setCapped(data.capped);
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
        const data = await apiFetch<{ preferences: { timelineEnabled: boolean } }>(PREFERENCES_URL);
        setEnabled(data.preferences.timelineEnabled);
      } catch {
        // 开关读不到就保持 null：界面显示「状态未知」，而不是假装它是关着的。
      }
    })();
  }, []);

  /** 只在开关确认是打开时读时间线：关着那一趟请求服务端也会 409，白跑一次解密。 */
  useEffect(() => {
    if (enabled === true) void loadTimeline();
  }, [enabled, loadTimeline]);

  async function toggleEnabled() {
    if (enabled === null || flagBusy) return;
    setFlagBusy(true);
    try {
      const data = await apiFetch<{ preferences: { timelineEnabled: boolean } }>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { timelineEnabled: !enabled }
      });
      setEnabled(data.preferences.timelineEnabled);
      push(data.preferences.timelineEnabled ? '认知时间线已打开' : '认知时间线已关闭');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  const shown = filter === 'all' ? events : events.filter((event) => event.category === filter);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">认知时间线</h2>
          <p className="mt-1 text-[12.5px] text-white/40">按事情发生的时间排列系统记住的内容。</p>
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
          关闭时这一屏不读取你的记忆。打开后才会列出。
        </Alert>
      ) : null}

      {enabled === true ? (
        <div className="mt-5 space-y-2.5">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {/* 一条事件都没有时不放筛选 chips：七个没人点的按钮摆在这儿，只会让人以为系统筛掉了内容。 */}
          {events.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {(['all', ...TYPE_ORDER] as Filter[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                  className={
                    filter === item
                      ? 'badge badge-green !px-2.5 !py-1 !text-[11.5px]'
                      : 'chip !px-2.5 !py-1 !text-[11.5px]'
                  }
                >
                  {item === 'all' ? '全部' : TYPE_LABELS[item]}
                </button>
              ))}
            </div>
          ) : null}
          {capped ? (
            <Alert tone="info">记忆条数已达上限：时间线只覆盖最近这一批，更早的没有读进来。</Alert>
          ) : null}

          {loading ? (
            <LoadingBlock label="加载时间线" />
          ) : events.length === 0 ? (
            <EmptyState
              icon={<History className="h-5 w-5" />}
              title="时间线还是空的"
              description="系统还没有记住任何内容。你在对话里说过的信息会先进入「记忆」，再出现在这里。"
            />
          ) : shown.length === 0 ? (
            <p className="text-[12px] text-white/40">这个类别还没有事件。</p>
          ) : (
            shown.map((event) => {
              const isOpen = openId === event.memoryId;
              // 退到记录时间的那一条不能只显示日期：那样就等于把「记下」说成「发生」。
              const when =
                event.timeSource === 'validity' ? describeValidRange(event) : `记于 ${timeAgo(event.recordedAt)}`;
              return (
                <div key={event.memoryId} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 text-left"
                    onClick={() => setOpenId(isOpen ? null : event.memoryId)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11.5px] text-white/35">{when}</span>
                      <span className="mt-1 block whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                        {event.content}
                      </span>
                      <span className="mt-2 flex flex-wrap gap-1.5">
                        <span className="chip !px-2 !py-0.5 !text-[10.5px]">{TYPE_LABELS[event.category]}</span>
                        <span className="chip !px-2 !py-0.5 !text-[10.5px]">{CONTEXT_LABELS[event.context]}</span>
                        <span
                          className={
                            event.origin === 'inferred' || event.origin === 'hypothesis'
                              ? 'badge badge-amber !px-2 !py-0.5 !text-[10.5px]'
                              : 'chip !px-2 !py-0.5 !text-[10.5px]'
                          }
                        >
                          {ORIGIN_LABELS[event.origin]}
                        </span>
                        {event.timeSource === 'recorded' ? (
                          <span className="badge badge-amber !px-2 !py-0.5 !text-[10.5px]">发生时间未知</span>
                        ) : null}
                      </span>
                    </span>
                    <ChevronDown className={cn('h-4 w-4 shrink-0 text-white/35 transition', isOpen ? 'rotate-180' : '')} />
                  </button>

                  {isOpen ? (
                    <div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
                      {event.version > 1 ? (
                        <p className="text-[11.5px] text-white/40">
                          {event.historyCount > 0
                            ? `第 ${event.version} 版 · 更早的 ${event.historyCount} 个版本已折叠`
                            : `第 ${event.version} 版 · 更早的版本已不在库里`}
                        </p>
                      ) : null}
                      {event.confirmedAt ? (
                        <p className="text-[11.5px] text-white/40">确认于 {timeAgo(event.confirmedAt)}</p>
                      ) : null}
                      <p className="text-[11.5px] text-white/30">旧版本在「记忆」那一屏点这条的「版本」查看。</p>
                      {event.chatId ? (
                        <p className="text-[11.5px] text-white/40">
                          {chats[event.chatId] ? (
                            <Link
                              href={`/chat/${encodeURIComponent(event.chatId)}`}
                              className="inline-block max-w-[260px] truncate align-bottom text-white/45 underline-offset-2 hover:text-white/80 hover:underline"
                            >
                              来自：{chats[event.chatId]}
                            </Link>
                          ) : (
                            <span>来自：原对话已删除</span>
                          )}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}
