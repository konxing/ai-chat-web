'use client';

import { useEffect, useState } from 'react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { Alert, LoadingBlock } from '@/components/ui';
import { describeEvidenceVolume, describeReflectionTime } from '@/lib/cognitive/reflection-display';
import {
  CHANGES_ARE_OBSERVATIONS_NOTE,
  CHANGES_EMPTY_NOTE,
  CHANGE_AFTER_LABEL,
  CHANGE_BEFORE_LABEL,
  INTEREST_SOURCE_NOTE,
  describeChangeConfirmation,
  describeChangeSignal,
  describeChangesCap,
  describeInsufficientChange
} from '@/lib/cognitive/change-display';
import type { ChangeObservation, ChangeSubject, InsufficientChange } from '@/lib/cognitive/change-detector';

/**
 * 认知时间线里的「变化」区块（任务书 4.3 的界面）。
 *
 * 它不是第三个开关：闸门是时间线那一屏的 `timelineEnabled`，这一区块跟着它一起显隐，
 * 自己不发 PATCH——同一个开关在两处各摆一个控件，关掉其中一个时用户不知道听谁的。
 * 它也不带纠正和删除：那两个动作的入口在下面的事件列表和「记忆」那一屏，一个动作一个入口。
 *
 * 三条从后端落下来的形状：
 * 一、句子全部来自 `change-display.ts` 的封闭句式表。界面里抄一份字面量，
 *    改了 display 的就是没显示的那一份。
 * 二、正文走旁表 `sources`，按 id 取。被引到的行如果已经不在这一批里（读到了上限），
 *    那一侧就整行不渲染——留一个空标签会被读成「之后没有说法」，而真实原因是没读进来。
 * 三、请求里没有任何时间参数：门槛是「隔了多少天」，客户端能传时间就能造出一条变化。
 *
 * 「证据不足」那一栏按（主题 + 理由）去重，只把句子说一遍：
 * 三个簇都差在同一条门槛上，是三句一模一样的话。服务端仍然把每一条都返回，
 * 那才是任务书 4.3 要的 INSUFFICIENT_EVIDENCE 输出。
 */

const CHANGES_URL = '/api/account/cognitive/changes';

interface ChangePayload {
  observations: ChangeObservation[];
  insufficient: InsufficientChange[];
  sources: Record<string, string>;
  capped: boolean;
}

export function TimelineChanges({ revision }: { revision: number }) {
  const [data, setData] = useState<ChangePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const payload = await apiFetch<ChangePayload>(CHANGES_URL);
        if (cancelled) return;
        setData(payload);
        setLoadError('');
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  if (loadError) return <Alert tone="error" className="mt-5">{loadError}</Alert>;
  if (loading && data === null) return <LoadingBlock label="加载变化观察" />;
  if (data === null) return null;

  const shown = new Set<ChangeSubject>([
    ...data.observations.map((observation) => observation.subject),
    ...data.insufficient.map((item) => item.subject)
  ]);

  return (
    <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.015] p-4">
      <h3 className="text-[13.5px] font-semibold text-white/80">变化</h3>
      <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">{CHANGES_ARE_OBSERVATIONS_NOTE}</p>

      {data.capped ? <p className="mt-2 text-[11.5px] leading-relaxed text-white/40">{describeChangesCap(true)}</p> : null}

      {data.observations.length === 0 && data.insufficient.length === 0 ? (
        <p className="mt-3 text-[12px] text-white/40">{CHANGES_EMPTY_NOTE}</p>
      ) : null}

      {data.observations.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {data.observations.map((observation, index) => (
            <li
              key={`${observation.subject}-${observation.change}-${observation.firstSeenAt}-${index}`}
              className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
            >
              <p className="text-[13px] text-white/85">{describeChangeSignal(observation.subject, observation.change)}</p>
              <p className="mt-1.5 text-[11.5px] text-white/40">
                {describeReflectionTime(observation.firstSeenAt, observation.lastSeenAt, observation.timePrecision)} ·{' '}
                {describeEvidenceVolume(observation.sampleCount, observation.observationSpanDays)}
              </p>
              <p className="mt-1 text-[11.5px] text-white/35">{describeChangeConfirmation(observation.confirmed)}</p>
              <div className="mt-2 space-y-1">
                {observation.beforeMemoryIds.map((id) =>
                  data.sources[id] ? (
                    <p key={id} className="text-[12px] leading-relaxed text-white/50">
                      <span className="text-white/30">{CHANGE_BEFORE_LABEL}</span>
                      {data.sources[id]}
                      <span className="ml-1 text-white/25">（{timeAgo(idleTime(id, observation))}）</span>
                    </p>
                  ) : null
                )}
                {observation.afterMemoryIds.map((id) =>
                  data.sources[id] ? (
                    <p key={id} className="text-[12px] leading-relaxed text-white/75">
                      <span className="text-white/30">{CHANGE_AFTER_LABEL}</span>
                      {data.sources[id]}
                    </p>
                  ) : null
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {data.insufficient.length > 0 ? (
        <div className="mt-4 border-t border-white/[0.06] pt-3">
          <p className="text-[11.5px] text-white/35">这些还没攒够证据：</p>
          <ul className="mt-1.5 space-y-1">
            {[...new Set(data.insufficient.map((item) => `${item.subject}|${item.reason}`))].map((key) => {
              const [subject, reason] = key.split('|') as [ChangeSubject, InsufficientChange['reason']];
              return (
                <li key={key} className="text-[12px] text-white/45">
                  {describeInsufficientChange(subject, reason)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {shown.has('INTEREST') ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-white/35">{INTEREST_SOURCE_NOTE}</p>
      ) : null}
    </div>
  );
}

/**
 * 「变化前」那一行的时间：观察结构只给了整条观察的首尾时刻，
 * 单行自己的记录时刻不在里面，所以这里取该侧对应的那个端点，而不是现编一个。
 */
function idleTime(id: string, observation: ChangeObservation): string {
  return observation.beforeMemoryIds.includes(id) ? observation.firstSeenAt : observation.lastSeenAt;
}
