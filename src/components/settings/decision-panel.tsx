'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Scale } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { Alert, EmptyState, LoadingBlock, Spinner, useToast } from '@/components/ui';

/**
 * 决策记忆那一屏（任务书 5.5 的界面）。
 *
 * 形状由后端状态机定：五个列表就是五个 status，候选行才有确认/拒绝两个按钮，
 * 已确认的行展开才看得到结果候选——结果关联的确认权在用户手里（5.3），
 * 所以候选链接永远带着「确认关联 / 解除关联」两个按钮，没有默认答案。
 *
 * 开关关着时这一屏连请求都不发，和时间线屏同一个口径；接口自己照样 409。
 */
const DECISIONS_URL = '/api/account/decisions';
const PREFERENCES_URL = '/api/account/cognitive';
const DECISION_URL = (id: string) => `/api/account/decisions/${encodeURIComponent(id)}`;
const OUTCOME_URL = (decisionId: string, outcomeId: string) =>
  `${DECISION_URL(decisionId)}/outcomes/${encodeURIComponent(outcomeId)}`;

type DecisionStatus =
  | 'PENDING_CONFIRM'
  | 'CONFIRMED'
  | 'AWAITING_REVIEW'
  | 'OUTCOME_RECORDED'
  | 'REJECTED';

interface DecisionDto {
  id: string;
  status: DecisionStatus;
  topic: string;
  choice: string;
  decidedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

interface OutcomeDto {
  id: string;
  decisionId: string;
  linkStatus: 'CANDIDATE' | 'LINKED' | 'DETACHED';
  actual: string;
  recordedAt: string;
}

const SECTIONS: Array<{ status: DecisionStatus; title: string }> = [
  { status: 'PENDING_CONFIRM', title: '待确认' },
  { status: 'CONFIRMED', title: '已确认' },
  { status: 'AWAITING_REVIEW', title: '待复盘' },
  { status: 'OUTCOME_RECORDED', title: '已记录结果' },
  { status: 'REJECTED', title: '已拒绝' }
];

export function DecisionPanel() {
  const { push } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [decisions, setDecisions] = useState<DecisionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomeDto[]>([]);
  const [outcomesLoading, setOutcomesLoading] = useState(false);
  const [outcomeBusyId, setOutcomeBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ decisions: DecisionDto[]; capped: boolean }>(DECISIONS_URL);
      setDecisions(data.decisions);
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
        const data = await apiFetch<{ preferences: { decisionMemoryEnabled: boolean } }>(
          PREFERENCES_URL
        );
        setEnabled(data.preferences.decisionMemoryEnabled);
      } catch {
        // 开关读不到就保持 null：界面显示「状态未知」，而不是假装它是关着的。
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
      const data = await apiFetch<{ preferences: { decisionMemoryEnabled: boolean } }>(
        PREFERENCES_URL,
        { method: 'PATCH', json: { decisionMemoryEnabled: !enabled } }
      );
      setEnabled(data.preferences.decisionMemoryEnabled);
      push(data.preferences.decisionMemoryEnabled ? '决策记忆已打开' : '决策记忆已关闭');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  async function act(decision: DecisionDto, action: 'confirm' | 'reject') {
    setBusyId(decision.id);
    try {
      await apiFetch(DECISION_URL(decision.id), { method: 'PATCH', json: { action } });
      setOpenId(null);
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  async function toggleOpen(decision: DecisionDto) {
    if (openId === decision.id) {
      setOpenId(null);
      return;
    }
    setOpenId(decision.id);
    setOutcomesLoading(true);
    try {
      const data = await apiFetch<{ decision: DecisionDto; outcomes: OutcomeDto[] }>(
        DECISION_URL(decision.id)
      );
      setOutcomes(data.outcomes);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setOutcomesLoading(false);
    }
  }

  async function actOutcome(decision: DecisionDto, outcome: OutcomeDto, action: 'link' | 'detach') {
    setOutcomeBusyId(outcome.id);
    try {
      await apiFetch(OUTCOME_URL(decision.id, outcome.id), { method: 'PATCH', json: { action } });
      const data = await apiFetch<{ decision: DecisionDto; outcomes: OutcomeDto[] }>(
        DECISION_URL(decision.id)
      );
      setOutcomes(data.outcomes);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setOutcomeBusyId('');
    }
  }

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">决策</h2>
          <p className="mt-1 text-[12.5px] text-white/40">
            开启后，AI 会把你亲口说出的重要决策记为待确认候选；只有你确认后才成为正式决策记录。
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
          决策记忆
        </label>
      </div>

      {enabled === false ? (
        <Alert tone="info" className="mt-4">
          决策记忆没有打开
        </Alert>
      ) : null}

      {enabled === true ? (
        <div className="mt-5 space-y-5">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {loading ? (
            <LoadingBlock label="加载决策" />
          ) : decisions.length === 0 ? (
            <EmptyState
              icon={<Scale className="h-5 w-5" />}
              title="还没有决策记录"
              description="你在对话里说「我决定……」时，这里会出现待确认的候选。"
            />
          ) : (
            SECTIONS.map((section) => {
              const rows = decisions.filter((decision) => decision.status === section.status);
              if (rows.length === 0) return null;
              return (
                <div key={section.status}>
                  <h3 className="mb-2 text-[12px] font-medium text-white/45">
                    {section.title}（{rows.length}）
                  </h3>
                  <div className="space-y-2.5">
                    {rows.map((decision) => {
                      const isOpen = openId === decision.id;
                      return (
                        <div
                          key={decision.id}
                          className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
                        >
                          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                            {decision.topic}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-white/55">
                            {decision.choice}
                          </p>
                          <p className="mt-1.5 text-[11.5px] text-white/35">
                            {timeAgo(decision.decidedAt ?? decision.createdAt)}
                          </p>

                          {decision.status === 'PENDING_CONFIRM' ? (
                            <div className="flex flex-wrap gap-2 pt-2">
                              <button
                                type="button"
                                className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                disabled={busyId === decision.id}
                                onClick={() => void act(decision, 'confirm')}
                              >
                                {busyId === decision.id ? <Spinner /> : null} 确认
                              </button>
                              <button
                                type="button"
                                className="btn-ghost !px-2.5 !py-1.5 !text-[12px] hover:text-red-300"
                                disabled={busyId === decision.id}
                                onClick={() => void act(decision, 'reject')}
                              >
                                拒绝
                              </button>
                            </div>
                          ) : null}

                          {decision.status === 'CONFIRMED' ||
                          decision.status === 'OUTCOME_RECORDED' ? (
                            <div className="pt-2">
                              <button
                                type="button"
                                className="flex items-center gap-1 text-[12px] text-white/50 hover:text-white/80"
                                onClick={() => void toggleOpen(decision)}
                              >
                                <ChevronDown
                                  className={cn('h-3.5 w-3.5 transition', isOpen ? '' : '-rotate-90')}
                                />
                                {isOpen ? '收起结果' : '查看结果'}
                              </button>
                              {isOpen ? (
                                <div className="mt-2 space-y-2 border-l border-white/[0.08] pl-3">
                                  {outcomesLoading ? (
                                    <LoadingBlock label="加载结果" />
                                  ) : outcomes.length === 0 ? (
                                    <p className="text-[12px] text-white/40">还没有结果记录。</p>
                                  ) : (
                                    outcomes.map((outcome) => (
                                      <div key={outcome.id} className="space-y-1">
                                        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-white/75">
                                          {outcome.actual}
                                        </p>
                                        {outcome.linkStatus === 'CANDIDATE' ? (
                                          <>
                                            <p className="text-[11.5px] text-white/40">
                                              AI 认为这句话可能是这条决策的结果，是否关联由你定。
                                            </p>
                                            <div className="flex flex-wrap gap-2">
                                              <button
                                                type="button"
                                                className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                                disabled={outcomeBusyId === outcome.id}
                                                onClick={() =>
                                                  void actOutcome(decision, outcome, 'link')
                                                }
                                              >
                                                确认关联
                                              </button>
                                              <button
                                                type="button"
                                                className="btn-ghost !px-2.5 !py-1.5 !text-[12px] hover:text-red-300"
                                                disabled={outcomeBusyId === outcome.id}
                                                onClick={() =>
                                                  void actOutcome(decision, outcome, 'detach')
                                                }
                                              >
                                                解除关联
                                              </button>
                                            </div>
                                          </>
                                        ) : (
                                          <p className="text-[11.5px] text-white/35">
                                            {outcome.linkStatus === 'LINKED' ? '已关联' : '已解除'}
                                          </p>
                                        )}
                                      </div>
                                    ))
                                  )}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )
        }
        </div>
      ) : null}
    </section>
  );
}
