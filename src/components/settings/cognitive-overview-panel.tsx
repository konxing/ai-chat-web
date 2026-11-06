'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import { Alert, LoadingBlock } from '@/components/ui';
import type { OverviewSection, OverviewSectionKey } from '@/lib/cognitive/overview';

/**
 * 「个人认知中心」那一屏（任务书 8.2 的入口聚合）。它是七张已有屏的门厅，不是第八张屏。
 *
 * 三条形状都是被前面的裁决逼出来的：
 *
 * 一、**数字一个都不在这里算**。右侧那一行直接是接口给的 `section.detail`；
 *    组件里写「2 条记忆」这种字面量只可能是猜的，而猜出来的数在隐私控件上就是撒谎。
 *    同理，这一屏不发第二个请求——七项全部来自 `/api/account/cognitive/overview` 一次读。
 *
 * 二、**这一屏没有任何开关**。九个设置各自留在自己那一屏（开关的读者也在那些屏的服务端里），
 *    门厅只领路。在这里再摆一排复选框，就是同一件事的第二个入口。
 *
 * 三、**关着的项照样给行，只是不给数**。点进去看到的是那一屏自己的那句话和服务端 409；
 *    门厅如果把它们藏起来，用户就找不到去哪儿把它们打开。`enabled` 决定的是行的明暗，不是有没有。
 *
 * 标签归界面，因为界面才知道自己链到哪个 tab；服务端只给 key、开关状态和那一句话。
 *
 * 测试：tests/unit/cognitive-overview.test.ts（静态断言，node 环境跑不了 JSX）
 */

/** 门厅能领去的七个去处，键名就是设置页左侧那一列的 tab。 */
export type OverviewTarget =
  | 'memoryGraph'
  | 'timeline'
  | 'reflections'
  | 'decisions'
  | 'userModel'
  | 'memory'
  | 'policy';

const ENTRY_COPY: Record<OverviewSectionKey, { label: string; hint: string; tab: OverviewTarget }> = {
  graph: { label: '记忆网络', hint: '看哪些记忆被画成相关', tab: 'memoryGraph' },
  timeline: { label: '认知时间线', hint: '同一件事的说法怎么随时间改', tab: 'timeline' },
  reflections: { label: 'AI 主动洞察', hint: '它主动想到、还没被你答复的推断', tab: 'reflections' },
  decisions: { label: '决策记录', hint: '你定过的选择和后面的结果', tab: 'decisions' },
  profile: { label: '画像', hint: '它对你的整体判断，可以改可以删', tab: 'userModel' },
  memory: { label: '记忆管理', hint: '查看、修改、忘记已经存下的记忆', tab: 'memory' },
  policy: { label: '记忆策略', hint: '每类话怎么记、留多久', tab: 'policy' }
};

const OVERVIEW_URL = '/api/account/cognitive/overview';

interface OverviewPayload {
  sections: OverviewSection[];
  preferencesUnavailable: boolean;
}

export function CognitiveOverviewPanel({ onOpen }: { onOpen: (tab: OverviewTarget) => void }) {
  const [payload, setPayload] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await apiFetch<OverviewPayload>(OVERVIEW_URL));
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

  if (loading) return <LoadingBlock label="正在数你的认知模块" />;
  if (error) {
    return (
      <Alert tone="error">
        <div>认知中心读不出来：{error}</div>
        <button type="button" className="btn-ghost mt-3" onClick={() => void load()}>
          重试
        </button>
      </Alert>
    );
  }
  if (!payload) return null;

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="text-[16px] font-semibold text-white">个人认知中心</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-white/40">
        七个模块各自的入口。这里的每一条数字都是从库里数出来的；模块没打开时不给数字，也不去读你的记忆内容。
      </p>
      {payload.preferencesUnavailable ? (
        <Alert tone="info" className="mt-4">
          暂时读不到你的模块设置，下面五项因此按「没打开」显示。这只影响这一屏的显示，你的记忆没有被改动。
        </Alert>
      ) : null}

      <ul className="mt-4 divide-y divide-white/[0.06]">
        {payload.sections.map((section) => {
          const copy = ENTRY_COPY[section.key];
          if (!copy) return null;
          return (
            <li key={section.key}>
              <button
                type="button"
                onClick={() => onOpen(copy.tab)}
                className="flex w-full items-center gap-3 py-3 text-left transition hover:bg-white/[0.03]"
              >
                <span className="min-w-0 flex-1">
                  <span className={section.enabled ? 'text-[13.5px] text-white' : 'text-[13.5px] text-white/45'}>
                    {copy.label}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-white/35">{copy.hint}</span>
                </span>
                <span
                  className={
                    section.enabled
                      ? 'shrink-0 text-right text-[12px] text-white/60'
                      : 'shrink-0 text-right text-[12px] text-white/30'
                  }
                >
                  {section.detail}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-white/25" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
