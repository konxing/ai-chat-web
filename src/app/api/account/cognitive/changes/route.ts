import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getCognitivePreferences } from '@/lib/cognitive/preferences';
import { MEMORY_LIST_MAX_ROWS, listMemories, listRevisionEdges } from '@/lib/cognitive/memories';
import { detectChanges } from '@/lib/cognitive/change-detector';

export const runtime = 'nodejs';

/**
 * 变化检测（任务书 4.3 那一屏的后端）。只读，没有写入口。
 *
 * 闸门与时间线是同一对：`timelineEnabled` 管这一屏显不显示，`memoryEnabled` 管这份数据能不能被读。
 * 后者是 1.1 逼出来的——变化检测读的就是长期记忆的正文，
 * 让它绕过 `memoryEnabled` 就等于给用户一个「关了还能看见」的洞。
 * 两道闸门一次读完、一次请求只读一遍偏好，和时间线路由一个形状。
 *
 * `now` 只能来自服务端：变化检测的门槛全是「隔了多少天」，
 * 如果客户端能传时间，把日期拨远一点就能凭空造出一条「放了很久没再提」。
 *
 * 返回的观察结构里没有任何正文（任务书要的是可追溯，不是可复读）：
 * 界面上「之前 / 之后」那两句原文走旁表 `sources`，只装被引到的行。
 * 这样以后要把某一条观察整包写进日志时，观察本身不会泄露用户说过什么。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const gates = await changeGates(user.id);
    if (!gates.timelineEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '认知时间线没有打开；打开后这里才会读取并展示你的记忆');
    }
    if (!gates.memoryEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '长期记忆没有打开；变化检测是它的派生视图，关掉后这里不读取记忆内容');
    }

    const [memories, edges] = await Promise.all([
      listMemories(user.id, { includeSuperseded: true }),
      listRevisionEdges(user.id)
    ]);
    const { observations, insufficient } = detectChanges({ now: new Date(), memories, edges });

    const cited = new Set<string>();
    for (const observation of observations) {
      for (const id of [...observation.beforeMemoryIds, ...observation.afterMemoryIds]) cited.add(id);
    }
    const sources: Record<string, string> = {};
    for (const memory of memories) {
      if (cited.has(memory.id)) sources[memory.id] = memory.content;
    }

    return {
      observations,
      insufficient,
      sources,
      capped: memories.length >= MEMORY_LIST_MAX_ROWS
    };
  });
}

async function changeGates(userId: string): Promise<{ timelineEnabled: boolean; memoryEnabled: boolean }> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return {
      timelineEnabled: preferences.timelineEnabled === true,
      memoryEnabled: preferences.memoryEnabled === true
    };
  } catch {
    return { timelineEnabled: false, memoryEnabled: false };
  }
}
