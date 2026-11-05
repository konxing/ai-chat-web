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
import type { EmotionTransparency } from '@/lib/cognitive/preferences';

/**
 * 记忆策略那一屏（任务书 1.2 / 1.3 / 8.3）。
 *
 * 只渲染真有代码在消费的字段：是否持久化、允许的类型、是否先问、是否允许作为洞察的依据、
 * 是否允许整理进画像、是否允许拿去联想、保留期，再加上一个全局的「情绪标注」档位。
 * 这张策略表里今天没有消费者的只剩 `emotionEnabled`——它在偏好表里，grep 得到的是存储和校验声明，
 * 没有任何运行时代码读它。把它做成能拨的控件，就是任务书第八节点名禁止的「用假的交互代替」，
 * 所以不放，接口和存储原样留着。
 *
 * 三个下游许可各是哪天有了读者才拿到控件的：
 * 「允许反思」11-04（洞察扫描 `reflection-sweep.ts` 真按这一列过闸）；
 * 「允许整理进画像」11-05 片 d（画像候选 `profile-candidates.ts:62`）；
 * 「允许拿去联想」11-06 片 j（记忆网络的关联池 `memory-graph.ts:97`——关掉那种情境的行不做锚点、
 * 也不做成员，但点还在图上、更新关系照旧）。
 *
 * 一屏同时只展开一张卡：七种情境各自七个控件，全摊开就是四十九控件同屏，
 * 谁也说不清刚才那一下点的是哪一条。这条规矩和「记忆」那一屏一致。
 */

const POLICIES_URL = '/api/account/cognitive/policies';
const PREFERENCES_URL = '/api/account/cognitive';

/**
 * 「情绪标注」三档的界面措辞。
 *
 * 这一组摆在这里而不是策略卡里，因为它是一个全局档位、七种情境共用一个值。
 * 名字刻意叫「标注」不叫「允许情绪」：`off` 这一档不是「把情绪记下来但不给你看」，
 * 而是情绪类的行**连候选池都不进**——那等于改了模型看到你什么，界面上必须把这层说出来。
 */
const EMOTION_ORDER: readonly EmotionTransparency[] = ['off', 'implicit', 'explicit'];
const EMOTION_LABELS: Record<EmotionTransparency, string> = {
  off: '不用情绪类记忆',
  implicit: '用，但不特别说明',
  explicit: '用，并说明有几条和情绪有关'
};

/** 只有这七个字段能被这一屏改动，草稿就只装这七个，免得把没消费者的字段一起回写。 */
interface Draft {
  allowPersistence: boolean;
  allowedMemoryTypes: MemoryType[];
  requireConfirmation: boolean;
  allowReflection: boolean;
  allowUserProfile: boolean;
  allowAssociation: boolean;
  retention: MemoryRetention;
}

function toDraft(policy: MemoryPolicy): Draft {
  return {
    allowPersistence: policy.allowPersistence,
    allowedMemoryTypes: [...policy.allowedMemoryTypes],
    requireConfirmation: policy.requireConfirmation,
    allowReflection: policy.allowReflection,
    allowUserProfile: policy.allowUserProfile,
    allowAssociation: policy.allowAssociation,
    retention: policy.retention
  };
}

function isSameDraft(left: Draft, right: Draft): boolean {
  return (
    left.allowPersistence === right.allowPersistence &&
    left.requireConfirmation === right.requireConfirmation &&
    left.allowReflection === right.allowReflection &&
    left.allowUserProfile === right.allowUserProfile &&
    left.allowAssociation === right.allowAssociation &&
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
  // 全局的「情绪标注」档位：读不到就摆 null，界面显示「档位未知」而不是假装它是默认那档。
  const [emotion, setEmotion] = useState<EmotionTransparency | null>(null);
  const [emotionBusy, setEmotionBusy] = useState(false);
  const [emotionError, setEmotionError] = useState('');

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

  // 情绪标注住在偏好表里，和策略表是两个接口，所以单独读一次。
  useEffect(() => {
    void loadEmotion();
  }, []);

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

  async function loadEmotion() {
    try {
      const data = await apiFetch<{ preferences: { emotionTransparency: EmotionTransparency } }>(PREFERENCES_URL);
      setEmotion(data.preferences.emotionTransparency);
    } catch {
      // 读失败留在 null：这一档的三个值都会改变模型看到的东西，猜一个默认值等于替用户决定。
      setEmotion(null);
    }
  }

  async function saveEmotion(next: EmotionTransparency) {
    if (next === emotion) return;
    setEmotionBusy(true);
    setEmotionError('');
    try {
      const data = await apiFetch<{ preferences: { emotionTransparency: EmotionTransparency } }>(PREFERENCES_URL, {
        method: 'PATCH',
        json: { emotionTransparency: next }
      });
      // 以服务端回读的值为准：界面跟着它走才不会和库里分叉。
      setEmotion(data.preferences.emotionTransparency);
      push('情绪标注已更新');
    } catch (err) {
      setEmotionError(errorMessage(err));
    } finally {
      setEmotionBusy(false);
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
                      <label className="flex items-start gap-2 text-[13px] text-white/75">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-emerald-400"
                          checked={draft.allowReflection}
                          onChange={(e) => setDraft({ ...draft, allowReflection: e.target.checked })}
                        />
                        允许从这种情境里反思
                      </label>
                      <p className="mt-1.5 text-[11.5px] text-white/35">
                        关掉后，这种情境里记下的内容不再作为洞察的依据。
                      </p>
                    </div>

                    <div>
                      <label className="flex items-start gap-2 text-[13px] text-white/75">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-emerald-400"
                          checked={draft.allowUserProfile}
                          onChange={(e) => setDraft({ ...draft, allowUserProfile: e.target.checked })}
                        />
                        允许把这种情境整理进画像
                      </label>
                      <p className="mt-1.5 text-[11.5px] text-white/35">
                        关掉后，这种情境里记下的内容不再作为画像候选的依据。
                      </p>
                    </div>

                    <div>
                      <label className="flex items-start gap-2 text-[13px] text-white/75">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-emerald-400"
                          checked={draft.allowAssociation}
                          onChange={(e) => setDraft({ ...draft, allowAssociation: e.target.checked })}
                        />
                        允许把这种情境拿去联想
                      </label>
                      <p className="mt-1.5 text-[11.5px] text-white/35">
                        关掉后，这种情境里的记忆不再和别的记忆连关联线；它自己的更新关系照旧。
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

      <div className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
        <h3 className="text-[13.5px] text-white/85">情绪标注</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-white/35">
          这一档只改「对话时模型看到的那批记忆里有没有情绪类的那几行」，不改记不记：
          上面的类型勾选决定落不落库，这里决定端不端给模型。
          三个档位都不会给你的情绪下判断，最亮的一档也只报一个条数。
        </p>

        <div className="mt-3">
          <label className="label">情绪类记忆的用法</label>
          <select
            className="field"
            value={emotion ?? ''}
            disabled={emotion === null || emotionBusy}
            onChange={(e) => void saveEmotion(e.target.value as EmotionTransparency)}
          >
            {emotion === null ? <option value="">档位未知</option> : null}
            {EMOTION_ORDER.map((option) => (
              <option key={option} value={option}>
                {EMOTION_LABELS[option]}
              </option>
            ))}
          </select>
          {emotion === null ? (
            <p className="mt-1.5 text-[11.5px] text-white/35">
              当前档位没读到。这里不替你猜一个，因为三个选项都会改变模型看到的内容。
            </p>
          ) : null}
          <ul className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-white/30">
            <li>{EMOTION_LABELS.off}：情绪类的行连候选池都不进，模型看不到它们。</li>
            <li>{EMOTION_LABELS.implicit}：和其它记忆一起端给模型，界面与提示里都不特别说明。</li>
            <li>{EMOTION_LABELS.explicit}：一起端给模型，并在末尾加一句「其中 N 条与情绪有关」。</li>
          </ul>
          {emotionError ? <Alert tone="error" className="mt-2">{emotionError}</Alert> : null}
        </div>
      </div>

      <p className="mt-5 text-[11.5px] leading-relaxed text-white/30">
        还没做的部分：策略表里的「关联」一列至今没有运行时代码读它，接口能保存但界面上不给控件；
        偏好表里的情绪总开关同理，能用的情绪控件只有上面那三档。
        「反思」「写入画像」两列已经有后台真按它们过闸——某个情境不放开反思，那个情境里的记忆就不会出现在洞察里；
        不放开画像，它就不出现在画像候选里。
      </p>
    </section>
  );
}
