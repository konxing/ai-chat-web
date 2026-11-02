import { api, getRequestIp, getUserAgent, jsonError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { memoryPurgeSchema } from '@/lib/validation';
import { listMemories } from '@/lib/cognitive/memories';
import { assessMemories } from '@/lib/cognitive/evidence';
import { purgeAllMemories, purgeMemoriesByChat } from '@/lib/cognitive/forgetting';
import { learnAfterPurge } from '@/lib/cognitive/policy-learner';
import { listChatTitles } from '@/lib/chats';
import type { Confidence } from '@/lib/cognitive/confidence';

export const runtime = 'nodejs';

/**
 * 清空全部一小时 3 次、按会话一小时 20 次：前者是一次不可逆的大动作，
 * 后者是用户逐个会话清理，得给足余地。两个桶分开，免得清空用掉的额度挡住正常清理。
 */
const PURGE_ALL_LIMIT = 3;
const PURGE_CHAT_LIMIT = 20;
const PURGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 我的记忆列表（任务书 8.2「记忆管理」）。正文是服务层解了密才回来的，收件人只有 session 里这一个用户。
 *
 * 这里不接任何过滤或翻页参数：多一个入口，就多一条通向别人账号的路，
 * 而当前有效的那几十条本来就一次读得完。
 *
 * chats 和 confidence 都是旁表，不塞进每条记忆里：MemoryDto 是服务层的形状，
 * 不该为了一个界面在这里编字段；而且同一个会话标题会被多条记忆共用。
 *
 * confidence 只给档位和因子，不给分数——一个三位小数会被当成精确真理，
 * 而它只是一条确定性规则的产物。因子是给界面翻译成中文用的，也是「凭什么信这条」的说明书。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const memories = await listMemories(user.id);
    const [chats, confidence] = await Promise.all([
      listChatTitles(
        user.id,
        memories.map((memory) => memory.chatId)
      ),
      memories.length === 0
        ? Promise.resolve(new Map<string, Confidence>())
        : assessMemories(user.id, memories)
    ]);
    return {
      memories,
      chats,
      confidence: Object.fromEntries(
        [...confidence].map(([id, entry]) => [id, { band: entry.band, factors: entry.factors }])
      )
    };
  });
}

/**
 * 批量永久删除（任务书 7.3 的「忘记某个来源会话产生的记忆」和「清空全部长期记忆」）。
 *
 * 范围只从查询串读，userId 只从 session 取：chatId 是任意字符串输入，
 * 但服务层的删除条件里始终带着 session 的 userId，塞别人的会话 id 只会删掉 0 行。
 * 两种范围都只删记忆，不动会话、附件和消息。
 */
export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const params = new URL(req.url).searchParams;
    const scope = memoryPurgeSchema.parse({
      scope: params.get('scope'),
      chatId: params.get('chatId')
    });

    if (scope.scope === 'all') {
      const limit = rateLimit(`memory-purge-all:${user.id}`, PURGE_ALL_LIMIT, PURGE_WINDOW_MS);
      if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
      const result = await purgeAllMemories(user.id);
      // 清空全部不产生学习证据，所以这里永远是空数组：一次重置不该被读成「七个情境都记太多了」。
      const learned = await learnAfterPurge(user.id, result.contexts);
      await audit(req, user, 'user.memory_purge_all', 'user', user.id, result.purged, learned);
      return { purged: result.purged, learned };
    }

    const limit = rateLimit(`memory-purge-chat:${user.id}`, PURGE_CHAT_LIMIT, PURGE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const result = await purgeMemoriesByChat(scope.chatId, user.id);
    const learned = await learnAfterPurge(user.id, result.contexts);
    await audit(req, user, 'user.memory_purge_by_chat', 'chat', scope.chatId, result.purged, learned);
    return { purged: result.purged, learned };
  });
}

/** 删除是不可逆动作，必须留痕；但审计里只有范围、目标 id、条数和情境枚举，没有正文（任务书 5.5）。 */
async function audit(
  req: Request,
  user: { id: string; username: string },
  action: string,
  targetType: string,
  targetId: string,
  purged: number,
  learned: readonly string[]
): Promise<void> {
  await writeAudit({
    actorId: user.id,
    actorLabel: user.username,
    action,
    targetType,
    targetId,
    after: { purged, learned },
    ip: getRequestIp(req),
    userAgent: getUserAgent(req)
  });
}
