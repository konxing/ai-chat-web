import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getCognitivePreferences } from '@/lib/cognitive/preferences';
import { listCitationEdges, listMemories, listRevisionEdges } from '@/lib/cognitive/memories';
import { deriveMemoryGraph } from '@/lib/cognitive/memory-graph';
import { listChatTitles } from '@/lib/chats';

export const runtime = 'nodejs';

/**
 * 记忆网络（任务书 8.2 那一屏的后端）。只读，没有写入口。
 *
 * 这张图**一个新字节都不写库**：三个读都是别的屏已经在读的——记忆行（记忆面板、时间线）、
 * 演化边（时间线）、共引用边（洞察一屏）。这一片做的事是把同一批行换一种画法，
 * 所以它没有自己的数据、没有自己的真相，也就没有「图上的关系和库里不一致」这种状态。
 * 2a 那次阈值校准判的是不建 `MemoryRelation`（`cognitive-memory-graph.test.ts` 里有一条静态用例
 * 钉着这个结论还没被推翻），这里就是那个结论的形状。
 *
 * 闸门是两道，和 `timeline/route.ts` 同一个理由：`associationEnabled` 管这一屏开不开，
 * `memoryEnabled` 管「能不能读 MemoryItem 的正文」。图是长期记忆的派生视图，
 * 关掉长期记忆之后这里照常返回内容，就等于给它开了个后门。
 * 偏好读不出来时按关闭处理——拿不准的时候宁可什么都不做。
 *
 * 节点上的会话标题走旁表，和记忆列表、时间线一样：GraphNode 是派生层的形状，
 * 不为一个界面编字段。空图时一次 `listChatTitles` 都不发。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const gates = await graphGates(user.id);
    if (!gates.associationEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '记忆网络没有打开；打开后这里才会读取并展示你的记忆关系');
    }
    if (!gates.memoryEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '长期记忆没有打开；记忆网络是它的派生视图，关掉后这里不读取记忆内容');
    }

    const [memories, edges, citations] = await Promise.all([
      listMemories(user.id, { includeSuperseded: true }),
      listRevisionEdges(user.id),
      listCitationEdges(user.id)
    ]);
    const graph = deriveMemoryGraph({ memories, edges, citations });
    const chatIds = [...new Set(graph.nodes.map((node) => node.chatId))].filter((id): id is string => id !== null);
    const chats = chatIds.length === 0 ? {} : await listChatTitles(user.id, chatIds);
    return { ...graph, chats };
  });
}

/**
 * 两道闸门一次读完。一次请求读一遍偏好，不是两道闸门各读一遍。
 */
async function graphGates(userId: string): Promise<{ associationEnabled: boolean; memoryEnabled: boolean }> {
  try {
    const preferences = await getCognitivePreferences(userId);
    return {
      associationEnabled: preferences.associationEnabled === true,
      memoryEnabled: preferences.memoryEnabled === true
    };
  } catch {
    return { associationEnabled: false, memoryEnabled: false };
  }
}
