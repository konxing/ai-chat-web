import { api, ApiError, getRequestIp, getUserAgent, jsonError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { restoreMemory } from '@/lib/cognitive/memories';

export const runtime = 'nodejs';

/** 和归档分桶：整理时「反悔」的那一路不该被自己刚才的归档动作挡掉。 */
const RESTORE_LIMIT = 60;
const RESTORE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 恢复一条已归档的记忆（任务书 7.2 里「仍可在允许范围内恢复」那半句的落点）。
 * 只清 archivedAt 一列：归档前是什么来源、什么版本、带着哪几条证据，恢复后还是那些——
 * 这正是它比撤回强的地方，撤回覆掉的 origin 没有人能替用户猜回来。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-restore:${user.id}`, RESTORE_LIMIT, RESTORE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const { id } = await ctx.params;

    const restored = await restoreMemory(id, user.id);
    if (!restored) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.memory_restore',
      targetType: 'memory',
      targetId: id,
      after: { restored: true },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { restored: true };
  });
}
