'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Lightbulb } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, Spinner, useToast } from '@/components/ui';
import {
  CITATION_KIND_LABELS,
  COOLDOWN_HINTS,
  COOLDOWN_LABELS,
  COOLDOWN_ORDER,
  REFLECTION_CONFIDENCE_LABELS,
  REFLECTION_SECTIONS,
  REFLECTION_SNOOZE_OPTIONS,
  REFLECTION_TYPE_LABELS,
  describeAlternatives,
  describeCounterEvidence,
  describeEvidenceVolume,
  describeGeneratedAt,
  describeListCap,
  describeReflectionTime,
  formatSnoozeDate,
  isActionable,
  splitPendingSection,
  type ReflectionCooldown
} from '@/lib/cognitive/reflection-display';

/**
 * 「AI 主动洞察」那一屏（任务书 6.4 的界面）。
 *
 * 形状由后端定，不是由好看定，三处硬约束：
 * 一、闸门先行。这一屏读的是**密文**，`reflectionEnabled` 没打开时连一个请求都不发——
 *    和时间线屏、决策屏同一个口径（reflections 路由自己也照样 409）。
 * 二、区就是状态。六个状态六个区，因为门槛 7 要的是「每个状态都有生产者」，而生产者写出来的
 *    行如果在界面上永远看不见，那条状态等于没被验收过。空区不渲染，理由和时间线屏不放
 *    没人点的筛选 chips 一样。
 * 三、只有待处理的行有按钮。状态机的入口只有 PENDING（reflections.ts 的 setReflectionStatus
 *    在 where 里带着它），给已处理的行摆按钮就是摆一个必然 409 的控件。
 *    「改写」这一版**不给入口**（11-04 判的乙）：服务端已经实现并且测过，只是不在这屏露出。
 *
 * 采纳一个字都不多写（6-B 立项的甲），所以这里的文案不许出现「已记住」——
 * 它只表示「你看过并同意」，不会变成一条记忆或画像。同理，这一版没有读侧注入（甲的 C 方案）：
 * 洞察只出现在这一屏，不会在聊天里被主动提起，标题下的说明必须把这条说出来。
 *
 * 错误文案一律直接显示服务端那句话：409/429/400 的话术在服务层和路由里各写过一遍，
 * 前端再抄一份就是第三套，迟早分叉。
 */
const REFLECTIONS_URL = '/api/account/cognitive/reflections';
const PREFERENCES_URL = '/api/account/cognitive';
const REFLECTION_URL = (id: string) => `${REFLECTIONS_URL}/${encodeURIComponent(id)}`;

interface ReflectionDto {
  id: string;
  type: keyof typeof REFLECTION_TYPE_LABELS;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EDITED' | 'SNOOZED' | 'EXPIRED';
  title: string;
  body: string;
  alternatives: string | null;
  /** 只有档位：分数不出服务端（片Q-3），所以这一屏拿不到 `0.62`，也就没法把它显示成精确数字。 */
  confidenceBand: keyof typeof REFLECTION_CONFIDENCE_LABELS;
  /** 服务端选出的「主要展示」三条之一；那个 0–1 的重要度不在这里，也不许在这里重算。 */
  isPrimary: boolean;
  sampleCount: number;
  observationSpanDays: number;
  counterHitCount: number;
  timeFrom: string | null;
  timeTo: string | null;
  timePrecision: 'UNKNOWN' | 'YEAR' | 'MONTH' | 'DAY' | 'TIMESTAMP';
  generatedAt: string;
  expiresAt: string | null;
  snoozedUntil: string | null;
  decidedAt: string | null;
}

interface CitationDto {
  id: string;
  kind: keyof typeof CITATION_KIND_LABELS;
  memoryId: string | null;
  decisionId: string | null;
  text: string | null;
}

export function ReflectionPanel() {
  const { push } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);
  const [cooldown, setCooldown] = useState<ReflectionCooldown | null>(null);
  const [cooldownBusy, setCooldownBusy] = useState(false);
  const [cooldownError, setCooldownError] = useState('');

  const [reflections, setReflections] = useState<ReflectionDto[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [citations, setCitations] = useState<CitationDto[]>([]);
  const [citationsLoading, setCitationsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ reflections: ReflectionDto[]; capped: boolean }>(REFLECTIONS_URL);
      setReflections(data.reflections);
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
        const data = await apiFetch<{
          preferences: { reflectionEnabled: boolean; reflectionCooldown: ReflectionCooldown };
        }>(PREFERENCES_URL);
        setEnabled(data.preferences.reflectionEnabled);
        setCooldown(data.preferences.reflectionCooldown);
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
      const data = await apiFetch<{ preferences: { reflectionEnabled: boolean } }>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { reflectionEnabled: !enabled }
      });
      setEnabled(data.preferences.reflectionEnabled);
      push(data.preferences.reflectionEnabled ? '主动洞察已打开' : '主动洞察已关闭');
      if (data.preferences.reflectionEnabled) await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  /**
   * 改节奏只发这一列：PATCH 体里带上八个开关就等于用户动一下下拉框把自己所有模块重置一遍，
   * 服务端那条「update 只带改动字段」的立场要在这里同样成立，得从请求体开始就不带别的。
   */
  async function saveCooldown(next: ReflectionCooldown) {
    if (next === cooldown) return;
    setCooldownBusy(true);
    setCooldownError('');
    try {
      const data = await apiFetch<{ preferences: { reflectionCooldown: ReflectionCooldown } }>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { reflectionCooldown: next }
      });
      // 以服务端回读的那一档为准：界面跟着它走才不会和库里分叉。
      setCooldown(data.preferences.reflectionCooldown);
      push('洞察生成节奏已更新');
    } catch (err) {
      setCooldownError(errorMessage(err));
    } finally {
      setCooldownBusy(false);
    }
  }

  async function act(reflection: ReflectionDto, action: 'accept' | 'reject') {
    setBusyId(reflection.id);
    try {
      await apiFetch(REFLECTION_URL(reflection.id), { method: 'PATCH', json: { action } });
      push(
        action === 'accept'
          ? '已采纳。这条洞察只记为「你看过并同意」，不会写进你的记忆。'
          : '已拒绝。只有以后新记进同话题的一句话，才会让它再出现。'
      );
      setOpenId(null);
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  async function snooze(reflection: ReflectionDto, days: 3 | 7 | 30) {
    setBusyId(reflection.id);
    try {
      const data = await apiFetch<{ reflection: ReflectionDto }>(REFLECTION_URL(reflection.id), {
        method: 'PATCH',
        json: { action: 'snooze', days }
      });
      // 推迟的时刻由服务端算回来：它自己加过天数，前端再算一次就会和库里的 snoozedUntil 分叉。
      const until = data.reflection.snoozedUntil;
      if (until !== null) push(`已推迟到 ${formatSnoozeDate(until)}`);
      setOpenId(null);
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  async function toggleOpen(reflection: ReflectionDto) {
    if (openId === reflection.id) {
      setOpenId(null);
      return;
    }
    setOpenId(reflection.id);
    setCitationsLoading(true);
    try {
      const data = await apiFetch<{ citations: CitationDto[] }>(REFLECTION_URL(reflection.id));
      setCitations(data.citations);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setCitationsLoading(false);
    }
  }

  // 原话已经不在了（那条记忆被删了）就不摆这一条：宁可少列，不编一句（门槛 4）。
  // 一条都不剩时落进「这条洞察没有可展示的原始依据。」那句。
  const shownCitations = citations.filter((citation) => citation.text !== null);

  // 服务端拿满 100 行才算截断；这句必须说出来，否则「这里没有更早的」会被读成「更早的没发生过」。
  const capNote = describeListCap(capped, reflections.length);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">AI 主动洞察</h2>
          <p className="mt-1 text-[12.5px] text-white/40">
            开启后，系统会定期从你已保存的记忆里找反复出现的模式、前后矛盾和长期未定的事，摆在这里等你处置。这些洞察不会在聊天里被主动提起。
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
          主动洞察没有打开
        </Alert>
      ) : null}

      {enabled === true ? (
        <div className="mt-5 space-y-5">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {capNote ? <Alert tone="info">{capNote}</Alert> : null}

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <h3 className="text-[13.5px] text-white/85">洞察生成节奏</h3>
            <p className="mt-1 text-[11.5px] leading-relaxed text-white/35">
              两次生成之间至少隔多久。这一档只改频率，不改任何判定标准：隔得越久攒下的记忆越多，
              一轮里能找出的反复模式也越站得住。
            </p>

            <div className="mt-3">
              <label className="label">生成节奏</label>
              <select
                className="field"
                value={cooldown ?? ''}
                disabled={cooldown === null || cooldownBusy}
                onChange={(e) => void saveCooldown(e.target.value as ReflectionCooldown)}
              >
                {cooldown === null ? <option value="">节奏未知</option> : null}
                {COOLDOWN_ORDER.map((option) => (
                  <option key={option} value={option}>
                    {COOLDOWN_LABELS[option]}
                  </option>
                ))}
              </select>
              {cooldown === null ? (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/35">
                  当前节奏没读到。这里不替你猜一档：猜错的那一档看起来像你选的，而它决定后台多久翻一次你的记忆。
                </p>
              ) : null}
              <ul className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-white/30">
                {COOLDOWN_ORDER.map((option) => (
                  <li key={option}>
                    {COOLDOWN_LABELS[option]}：{COOLDOWN_HINTS[option]}
                  </li>
                ))}
              </ul>
              {cooldownError ? (
                <Alert tone="error" className="mt-2">
                  {cooldownError}
                </Alert>
              ) : null}
            </div>
          </div>
          {loading ? (
            <LoadingBlock label="加载洞察" />
          ) : reflections.length === 0 ? (
            <EmptyState
              icon={<Lightbulb className="h-5 w-5" />}
              title="还没有洞察"
              description="洞察一天最多生成三条，且只在你的记忆攒够证据时生成。今天没话可说，它就真的不说。"
            />
          ) : (
            REFLECTION_SECTIONS.map((section) => {
              const rows = reflections.filter((item) => item.status === section.status);
              if (rows.length === 0) return null;
              // 只有待处理那一区有子块；其余五区拿到的是整块且不带小标题（纯函数里定的形状）。
              const groups = splitPendingSection(rows);
              return (
                <div key={section.status}>
                  <h3 className="mb-2 text-[12px] font-medium text-white/45">
                    {section.title}（{rows.length}）
                  </h3>
                  <div className="space-y-2.5">
                    {groups.map((group) => (
                      <div key={group.key} className="space-y-2.5">
                        {group.title ? (
                          <h4 className="mb-2 text-[11.5px] font-medium text-white/35">{group.title}</h4>
                        ) : null}
                        {group.rows.map((reflection) => {
                          const actionable = isActionable(reflection.status);
                          const timeLine = describeReflectionTime(
                            reflection.timeFrom,
                            reflection.timeTo,
                            reflection.timePrecision
                          );
                          const alternativesLine = describeAlternatives(reflection.alternatives);
                          const counterLine = describeCounterEvidence(reflection.counterHitCount);
                          const isOpen = openId === reflection.id;
                          return (
                            <div
                              key={reflection.id}
                              className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="chip !px-2.5 !py-1 !text-[11.5px]">
                                  {REFLECTION_TYPE_LABELS[reflection.type]}
                                </span>
                                <span className="text-[11.5px] text-white/35">
                                  {REFLECTION_CONFIDENCE_LABELS[reflection.confidenceBand]}
                                </span>
                                {timeLine ? (
                                  <span className="text-[11.5px] text-white/35">{timeLine}</span>
                                ) : null}
                                <span className="text-[11px] text-white/25">
                                  {describeGeneratedAt(reflection.generatedAt)}
                                </span>
                              </div>
                              <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                                {reflection.title}
                              </p>
                              <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-white/55">
                                {reflection.body}
                              </p>
                              {alternativesLine ? (
                                <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/45">
                                  {alternativesLine}
                                </p>
                              ) : null}
                              <p className="mt-1.5 text-[11.5px] text-white/35">
                                {describeEvidenceVolume(reflection.sampleCount, reflection.observationSpanDays)}
                                {counterLine ? ` · ${counterLine}` : ''}
                              </p>
                              {reflection.status === 'EXPIRED' ? (
                                <p className="mt-1.5 text-[11.5px] text-white/40">这条洞察 30 天没人处理，已过期</p>
                              ) : null}
                              {reflection.status === 'SNOOZED' && reflection.snoozedUntil !== null ? (
                                <p className="mt-1.5 text-[11.5px] text-white/40">
                                  已推迟到 {formatSnoozeDate(reflection.snoozedUntil)}
                                </p>
                              ) : null}

                              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                  onClick={() => void toggleOpen(reflection)}
                                >
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-180' : ''}`}
                                  />
                                  依据
                                </button>
                                {actionable ? (
                                  <>
                                    <button
                                      type="button"
                                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                      disabled={busyId === reflection.id}
                                      onClick={() => void act(reflection, 'accept')}
                                    >
                                      {busyId === reflection.id ? <Spinner /> : null} 采纳
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px] hover:text-red-300"
                                      disabled={busyId === reflection.id}
                                      onClick={() => void act(reflection, 'reject')}
                                    >
                                      拒绝
                                    </button>
                                    <span className="text-[11.5px] text-white/35">稍后</span>
                                    {REFLECTION_SNOOZE_OPTIONS.map((option) => (
                                      <button
                                        key={option.days}
                                        type="button"
                                        className="chip !px-2.5 !py-1 !text-[11.5px]"
                                        disabled={busyId === reflection.id}
                                        onClick={() => void snooze(reflection, option.days)}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </>
                                ) : null}
                              </div>

                              {isOpen ? (
                                <div className="mt-2.5 border-t border-white/[0.06] pt-2.5">
                                  {citationsLoading ? (
                                    <LoadingBlock label="加载依据" />
                                  ) : shownCitations.length === 0 ? (
                                    <p className="text-[12px] text-white/40">这条洞察没有可展示的原始依据。</p>
                                  ) : (
                                    <ul className="space-y-1.5">
                                      {shownCitations.map((citation) => (
                                        <li
                                          key={citation.id}
                                          className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-white/60"
                                        >
                                          {CITATION_KIND_LABELS[citation.kind]}
                                          {citation.text}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}
