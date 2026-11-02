'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { Alert, LoadingBlock, Spinner, useToast } from '@/components/ui';
import {
  CONTEXT_LABELS,
  CONTEXT_ORDER,
  RETENTION_LABELS,
  RETENTION_ORDER,
  TYPE_LABELS,
  TYPE_ORDER,
  describePolicySummary
} from '@/lib/cognitive/memory-display';
import type { MemoryContext, MemoryPolicy, MemoryRetention, MemoryType } from '@/lib/cognitive/policy';
import type { PolicyLearningState } from '@/lib/cognitive/policy-learner';

/**
 * 记忆策略那一屏（任务书 1.2 / 1.3 / 8.3）。
 *
 * 只渲染真有代码在消费的四个字段：是否持久化、允许的类型、是否先问、保留期。
 * 同一张策略表里的「写入画像 / 反思 / 关联」三项没有消费者——那三个模块还不存在；
 * 偏好表里的八个开关也只有 memoryEnabled 是真的。把它们做成能拨的控件，
 * 就是任务书第八节点名禁止的「用假的交互代替」，所以一个都不放，接口和存储原样留着。
 *
 * 一屏同时只展开一张卡：七种情境各自四个控件，全摊开就是二十八控件同屏，
 * 谁也说不清刚才那一下点的是哪一条。这条规矩和「记忆」那一屏一致。
 */

const POLICIES_URL = '/api/account/cognitive/policies';

/** 只有这四个字段能被这一屏改动，草稿就只装这四个，免得把没消费者的字段一起回写。 */
interface Draft {
  allowPersistence: boolean;
  allowedMemoryTypes: MemoryType[];
  requireConfirmation: boolean;
  retention: MemoryRetention;
}

function toDraft(policy: MemoryPolicy): Draft {
  return {
    allowPersistence: policy.allowPersistence,
    allowedMemoryTypes: [...policy.allowedMemoryTypes],
    requireConfirmation: policy.requireConfirmation,
    retention: policy.retention
  };
}

function isSameDraft(left: Draft, right: Draft): boolean {
  return (
    left.allowPersistence === right.allowPersistence &&
    left.requireConfirmation === right.requireConfirmation &&
    left.retention === right.retention &&
    [...left.allowedMemoryTypes].sort().join(',') === [...right.allowedMemoryTypes].sort().join(',')
  );
}

export function MemoryPolicyPanel() {
  const { push } = useToast();
  const [policies, setPolicies] = useState<Record<MemoryContext, MemoryPolicy> | null>(null);
  const [learning, setLearning] = useState<Record<MemoryContext, PolicyLearningState> | null>(null);
  const [threshold, setThreshold] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState<MemoryContext | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{
        policies: Record<MemoryContext, MemoryPolicy>;
        learning: Record<MemoryContext, PolicyLearningState>;
        learningThreshold: number;
      }>(POLICIES_URL);
      setPolicies(data.policies);
      setLearning(data.learning);
      setThreshold(data.learningThreshold);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function close() {
    setOpen(null);
    setDraft(null);
    setFormError('');
  }

  /** 再点同一张卡收起；点别的卡就换过去——同时只有一个展开区。 */
  function toggle(context: MemoryContext) {
    if (!policies) return;
    if (open === context) {
      close();
      return;
    }
    setFormError('');
    setOpen(context);
    setDraft(toDraft(policies[context]));
  }

  function toggleType(type: MemoryType) {
    setDraft((current) => {
      if (!current) return current;
      if (current.allowedMemoryTypes.includes(type)) {
        return { ...current, allowedMemoryTypes: current.allowedMemoryTypes.filter((item) => item !== type) };
      }
      // 按固定顺序重排，勾来勾去也不会让 chips 在界面上跳位。
      return {
        ...current,
        allowedMemoryTypes: TYPE_ORDER.filter((item) => item === type || current.allowedMemoryTypes.includes(item))
      };
    });
  }

  async function save(context: MemoryContext, next: Draft) {
    setBusy(true);
    try {
      await apiFetch<{ policy: MemoryPolicy }>(POLICIES_URL, {
        method: 'PATCH',
        json: { context, patch: next }
      });
      push('策略已更新');
      close();
      // 重新读一遍而不是就地打补丁：这一改同时留下了「用户已接管」的标记，
      // 学习状态得跟着刷新，否则界面上还挂着上一轮的学习提示。
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset(context: MemoryContext) {
    setBusy(true);
    try {
      await apiFetch<{ policy: MemoryPolicy }>(
        `${POLICIES_URL}?context=${encodeURIComponent(context)}`,
        { method: 'DELETE' }
      );
      push('已恢复默认');
      close();
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-5 sm:p-6">
      <div>
        <h2 className="text-[16px] font-semibold text-white">记忆策略</h2>
        <p className="mt-1 text-[12.5px] text-white/40">按情境决定记不记、记哪些类型、留多久。</p>
      </div>

      <Alert tone="info" className="mt-4">
        前三个开关只影响之后产生的记忆。保留期对已经存下的记忆同样生效：过了期限就不再进入对话，
        但记录不会被删，仍可在「记忆」里查看和撤回。
      </Alert>

      <div className="mt-5 space-y-2.5">
        {loadError ? <Alert tone="error">{loadError}</Alert> : null}
        {policies ? (
          CONTEXT_ORDER.map((context) => {
            const policy = policies[context];
            const isOpen = open === context && draft !== null;
            const dirty = draft !== null && !isSameDraft(draft, toDraft(policy));
            return (
              <div key={context} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left"
                  onClick={() => toggle(context)}
                >
                  <span className="min-w-0">
                    <span className="block text-[13.5px] text-white/85">{CONTEXT_LABELS[context]}</span>
                    <span className="mt-1 block truncate text-[11.5px] text-white/35">
                      {describePolicySummary(policy)}
                    </span>
                    {/* 学习层替用户做的决定不许是隐形的。阈值取自接口，不写死在文案里。 */}
                    {learning?.[context]?.learnedAt ? (
                      <span className="mt-1 block truncate text-[11.5px] text-amber-300/70">
                        已按你最近 {threshold} 次永久删除自动收紧 · 可重置
                      </span>
                    ) : null}
                  </span>
                  <ChevronDown
                    className={cn('h-4 w-4 shrink-0 text-white/35 transition', isOpen ? 'rotate-180' : '')}
                  />
                </button>

                {isOpen && draft ? (
                  <div className="mt-3 space-y-3.5 border-t border-white/[0.06] pt-3">
                    <label className="flex items-start gap-2 text-[13px] text-white/75">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-emerald-400"
                        checked={draft.allowPersistence}
                        onChange={(e) => setDraft({ ...draft, allowPersistence: e.target.checked })}
                      />
                      允许长期保存
                    </label>

                    <div>
                      <label className="label">允许记住的类型</label>
                      <div className="flex flex-wrap gap-1.5">
                        {TYPE_ORDER.map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => toggleType(type)}
                            className={
                              draft.allowedMemoryTypes.includes(type)
                                ? 'badge badge-green !px-2.5 !py-1 !text-[11.5px]'
                                : 'chip !px-2.5 !py-1 !text-[11.5px]'
                            }
                          >
                            {TYPE_LABELS[type]}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1.5 text-[11.5px] text-white/35">一个都不选，这种情境就什么都不记。</p>
                    </div>

                    <div>
                      <label className="flex items-start gap-2 text-[13px] text-white/75">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-emerald-400"
                          checked={draft.requireConfirmation}
                          onChange={(e) => setDraft({ ...draft, requireConfirmation: e.target.checked })}
                        />
                        记之前先问我
                      </label>
                      <p className="mt-1.5 text-[11.5px] text-white/35">
                        打开后这种情境的内容不会自动落库。确认界面还没做，所以目前的效果等于「一律不记」。
                      </p>
                    </div>

                    <div>
                      <label className="label">保留期</label>
                      <select
                        className="field"
                        value={draft.retention}
                        onChange={(e) => setDraft({ ...draft, retention: e.target.value as MemoryRetention })}
                      >
                        {RETENTION_ORDER.map((retention) => (
                          <option key={retention} value={retention}>
                            {RETENTION_LABELS[retention]}
                          </option>
                        ))}
                      </select>
                    </div>

                    {formError ? <Alert tone="error">{formError}</Alert> : null}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5 !text-[12px]"
                        disabled={busy || !dirty}
                        onClick={() => void save(context, draft)}
                      >
                        {busy ? <Spinner /> : null} 保存
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5 !text-[12px]"
                        disabled={busy}
                        onClick={() => void reset(context)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> 恢复默认
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        ) : loadError ? null : (
          <LoadingBlock label="加载策略" />
        )}
      </div>

      <p className="mt-5 text-[11.5px] leading-relaxed text-white/30">
        还没做的部分：用户画像、情绪、关联、时间线、反思、决策记忆六个模块尚未实现，它们的开关不会出现在这里，
        等模块落地再一起上。策略里的「写入画像 / 反思 / 关联」三项接口已能保存，但目前没有代码读取。
      </p>
    </section>
  );
}
