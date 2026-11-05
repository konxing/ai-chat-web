'use client';

import { useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { Alert, EmptyState, Spinner, useToast } from '@/components/ui';
import { CONTEXT_LABELS, TYPE_LABELS, describeCandidateListCap } from '@/lib/cognitive/memory-display';
import type { MemoryCandidateDto } from '@/lib/cognitive/memory-candidates';

/**
 * 「等你回答的话」那一块（任务书 1.2 的 ASK_CONFIRM，片M 的界面那一半）。
 *
 * 它挂在记忆屏的最上面，形状和别的认知屏**相反**，三处都是刻意的：
 *
 * 一、**这一块不问 `memoryEnabled`，一个字都不问。** 它是隐私控件不是模块视图：用户关掉长期记忆之后，
 *     门口还站着一排没答过的原话，那些句子密文存在库里。看不见也答不了，等于系统替他留着他的话。
 *     所以这里连偏好的读取都不发（第三次请求换成的是更少的信息，不是更多的安全）。
 *     真正的闸门在「记住」那一步的服务端：那一笔要往长期库写一行，关着就 409，界面上把那句人话原样报出来。
 *
 * 二、**两个动作，没有第三个。** 不给「先搁着」的档位，这屏就会长成一个谁都不当场回答的收件箱——
 *     而待确认池到上限会淘汰最旧的没答过的句子，「搁着」的真实含义是「过些天这句话自己消失」。
 *
 * 三、**两份列表一起读，空了才整块不渲染。** 只读待确认的那一份就答不了「这句为什么不再问了」：
 *     用户答过最后一个「不要记」之后，那一块会当场消失，而他刚做的那个决定从此没有地方查。
 *     答案就是那一条已拒绝行，它只在 `status=rejected` 这一档里出现，所以那一读必须在这儿发生。
 *
 * 正文（用户原话）只摆在这块界面上，不进 console、不进任何日志出口。
 *
 * 测试：tests/unit/cognitive-candidate-panel.test.ts（静态断言，node 环境跑不了 JSX）
 */

interface Props {
  /** 「记住」之后父级要重读记忆列表：那一行刚成为长期记忆，不刷新就是屏上少一条。 */
  onConfirmed: () => void;
}

type View = 'pending' | 'rejected';

/** 两个动词各自写全请求体，和上面的读同一套写法：界面上不许出现由变量拼出来的端点或动作。 */
const DECIDE_INIT = {
  confirm: { method: 'PATCH', json: { action: 'confirm' } },
  reject: { method: 'PATCH', json: { action: 'reject' } }
} as const;

const DECIDE_URL = '/api/account/cognitive/candidates';

export function MemoryCandidatesPanel({ onConfirmed }: Props) {
  const { push } = useToast();
  const [pending, setPending] = useState<MemoryCandidateDto[]>([]);
  const [rejected, setRejected] = useState<MemoryCandidateDto[]>([]);
  const [capped, setCapped] = useState(false);
  const [rejectedCapped, setRejectedCapped] = useState(false);
  const [view, setView] = useState<View>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 一次只许一个动作在飞：同一行双击会撞服务端那句 409，别的行也一起禁用，免得两份列表各自漂。 */
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [asks, answered] = await Promise.all([
        apiFetch<{ candidates: MemoryCandidateDto[]; capped: boolean }>('/api/account/cognitive/candidates'),
        apiFetch<{ candidates: MemoryCandidateDto[]; capped: boolean }>('/api/account/cognitive/candidates?status=rejected')
      ]);
      setPending(asks.candidates);
      setCapped(asks.capped);
      setRejected(answered.candidates);
      setRejectedCapped(answered.capped);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(entry: MemoryCandidateDto, action: keyof typeof DECIDE_INIT) {
    if (busy) return;
    setBusy(entry.id);
    try {
      await apiFetch(`${DECIDE_URL}/${encodeURIComponent(entry.id)}`, DECIDE_INIT[action]);
      if (action === 'confirm') {
        push('已记住');
        onConfirmed();
      } else {
        push('这句不再问了');
      }
      await load();
    } catch (err) {
      // 闸门拦住的确认由服务端给那句人话，这里原样报出来，不自己编一句。
      push(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  if (loading) return null;
  if (error) {
    return (
      <Alert tone="error" className="mt-4">
        等你回答的话读不出来：{error}
      </Alert>
    );
  }
  if (pending.length === 0 && rejected.length === 0) return null;

  const shown = view === 'pending' ? pending : rejected;
  const capNote =
    view === 'pending'
      ? describeCandidateListCap(capped, pending.length)
      : describeCandidateListCap(rejectedCapped, rejected.length);

  return (
    <section className="mt-5 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-medium text-white/85">
            <HelpCircle className="h-4 w-4" />
            等你回答的话
          </h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            这些句子系统想记，但按你的策略得先问你。你没答过的，一条都不会进长期记忆。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[12px]">
          <button
            type="button"
            onClick={() => setView('pending')}
            className={view === 'pending' ? 'chip !px-2.5 !py-0.5' : 'text-white/40 hover:text-white/70'}
          >
            还没答的{pending.length > 0 ? `（${pending.length}）` : ''}
          </button>
          <button
            type="button"
            onClick={() => setView('rejected')}
            className={view === 'rejected' ? 'chip !px-2.5 !py-0.5' : 'text-white/40 hover:text-white/70'}
          >
            不再问的
          </button>
        </div>
      </div>
      {capNote ? (
        <Alert tone="info" className="mt-3">
          {capNote}
        </Alert>
      ) : null}

      <div className="mt-3 space-y-2.5">
        {shown.length === 0 ? (
          <EmptyState
            icon={<HelpCircle className="h-5 w-5" />}
            title="没有等你回答的话"
            description={view === 'pending' ? '系统想记但要先问你的句子会出现在这里。' : '还没有答过「不要记」的句子。'}
          />
        ) : (
          shown.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
              <p className="text-[13px] leading-relaxed text-white/85">{entry.content}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-white/30">
                <span>
                  {CONTEXT_LABELS[entry.context]} · {TYPE_LABELS[entry.type]}
                </span>
                <span>
                  {view === 'pending'
                    ? `问于 ${timeAgo(entry.createdAt)}`
                    : `答于 ${entry.decidedAt ? timeAgo(entry.decidedAt) : '时间未知'}`}
                </span>
              </div>
              {view === 'pending' ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary !px-3 !py-1.5 !text-[12px]"
                    disabled={busy !== ''}
                    onClick={() => void decide(entry, 'confirm')}
                  >
                    {busy === entry.id ? <Spinner className="mr-1" /> : null}
                    记住
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1.5 !text-[12px]"
                    disabled={busy !== ''}
                    onClick={() => void decide(entry, 'reject')}
                  >
                    不要记
                  </button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
