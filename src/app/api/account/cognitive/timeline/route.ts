import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getCognitivePreferences } from '@/lib/cognitive/preferences';
import { MEMORY_LIST_MAX_ROWS, listMemories, listRevisionEdges } from '@/lib/cognitive/memories';
import { deriveTimelineEvents } from '@/lib/cognitive/timeline';
import { listChatTitles } from '@/lib/chats';

export const runtime = 'nodejs';

/**
 * 认知时间线（任务书 4.4 那一屏的后端）。只读，没有写入口。
 *
 * 这里是 `timelineEnabled` 这个开关的第一个消费者。在那之前它只是一个存进库里的布尔值：
 * 任务书要求模块开关「服务端强制」，而服务端从头到尾没人读过它——开关显示得再准，
 * 关掉之后数据照样被读出来，那就是个装饰。所以闸门放在最前面：
 * 关着就连记忆行都不捞，而不是捞回来让界面自己不显示。
 *
 * 偏好读不出来时按关闭处理，和 manager.ts 的 `enabledModules` 同一个口径：
 * 认知引擎拿不准的时候宁可什么都不做。
 *
 * 事件本身由 `deriveTimelineEvents` 从记忆行 + 演化边派生，这里不新增任何事实。
 * chats 和记忆列表一样做成旁表：MemoryDto 是服务层的形状，不该为一个界面编字段。
 * capped 说的是「这次读到的行数顶到了上限」——时间线只覆盖最近这一批记忆，
 * 更老的历史没被读回来，界面得能把这句话说出来，不然空出来的那段会被当成「那阵子没事发生」。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const gates = await timelineGates(user.id);
    if (!gates.timelineEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '认知时间线没有打开；打开后这里才会读取并展示你的记忆');
    }
    if (!gates.memoryEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '长期记忆没有打开；时间线是它的派生视图，关掉后这里不读取记忆内容');
    }

    const [memories, edges] = await Promise.all([
      listMemories(user.id, { includeSuperseded: true }),
      listRevisionEdges(user.id)
    ]);
    const events = deriveTimelineEvents({ memories, edges });
    const chats = await listChatTitles(
      user.id,
      events.map((event) => event.chatId)
    );
    return { events, chats, capped: memories.length >= MEMORY_LIST_MAX_ROWS };
  });
}

/**
 * 两道闸门一次读完：时间线自己的开关，加上它读的那份数据的开关。
 * 后者是 1.1「关闭模块后不能继续执行对应的数据读取」逼出来的——`timelineEnabled` 管不着
 * 「能不能读 MemoryItem 的正文」，那是长期记忆模块的地盘，派生视图不能成为绕过它的后门。
 * 一次请求读一遍偏好，不是两道闸门各读一遍。
 */
async function timelineGates(userId: string): Promise<{ timelineEnabled: boolean; memoryEnabled: boolean }> {
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
