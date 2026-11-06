'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { Alert } from '@/components/ui';
import {
  FAILED_TASK_REASON_LABELS,
  describeFailedTaskAttempt,
  describeFailedTaskListCap
} from '@/lib/cognitive/memory-display';
import type { FailedTaskDto } from '@/lib/cognitive/failed-tasks';

/**
 * 「没记上的句子」那一块（任务书 §6 要求④「支持失败任务查看」的界面那一半）。
 *
 * 它排在待确认那块下面、记忆列表上面，三处形状是刻意的：
 *
 * 一、**这一块不问任何模块开关**（裁决同 片L-1、同 `failed-tasks/route.ts` 头上那段）。
 *    它读的全是 CognitiveTask 的调度列，一行记忆都不解密；而失败偏偏发生在模块开着的时候。
 *    给它补一道闸门，等于把「系统漏了哪几句」这件事交给运维，用户自己反而看不见。
 *
 * 二、**只有看，没有动作。** 这一屏不许出现「重跑」：判死的那一条里，超时那一档我们并不知道
 *    写没写进去，重跑正是「同一句话记两条」的来源（task-worker.ts 就是为此才把它判死而不是重试）。
 *    要那句话重新被记住，办法是回到对话里再说一遍——所以唯一的出口是那次对话。
 *
 * 三、**没有正文，也没有消息坐标。** 接口只回 chatId：会话页没有「滚到某一句」的锚点，
 *    给了坐标也点不动。所以这里明说「只带你到那次对话门口」，不假装能找到那一句。
 *
 * 一条判死都没有时整块不渲染：一排空的「没记上的句子」标题只会让人以为系统在瞒话。
 *
 * 测试：tests/unit/cognitive-failed-task-panel.test.ts（静态断言，node 环境跑不了 JSX）
 */

export function FailedTasksPanel() {
  const [tasks, setTasks] = useState<FailedTaskDto[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data =
        await apiFetch<{ tasks: FailedTaskDto[]; capped: boolean }>('/api/account/cognitive/failed-tasks');
      setTasks(data.tasks);
      setCapped(data.capped);
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

  if (loading) return null;
  if (error) {
    return (
      <Alert tone="error" className="mt-4">
        没记上的句子读不出来：{error}
      </Alert>
    );
  }
  if (tasks.length === 0) return null;

  const capNote = describeFailedTaskListCap(capped, tasks.length);

  return (
    <section className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div>
          <h3 className="text-[13.5px] font-medium text-white/85">没记上的句子</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            后台想把你对话里的话记进长期记忆，有几句试到最后没能完成。原话还在那次对话里，这里只带你到那次对话门口。
          </p>
        </div>
      </div>
      {capNote ? (
        <Alert tone="info" className="mt-3">
          {capNote}
        </Alert>
      ) : null}

      <ul className="mt-3 space-y-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-[12.5px] leading-relaxed"
          >
            <span className="text-white/75">{FAILED_TASK_REASON_LABELS[task.reason]}</span>
            <span className="ml-2 text-white/30">
              {describeFailedTaskAttempt(task.attempts)} · {timeAgo(task.failedAt)}
            </span>
            <a
              href={`/chat/${encodeURIComponent(task.chatId)}`}
              className="ml-2 text-white/55 underline decoration-white/20 underline-offset-2 hover:text-white/85"
            >
              去看那次对话
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
