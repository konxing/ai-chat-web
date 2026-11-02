import { api, ApiError, getRequestIp, getUserAgent, jsonError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { removeExclusion } from '@/lib/cognitive/exclusions';

export const runtime = 'nodejs';

/** 一小时 30 次：用户逐条撤销是正常行为，但账号被盗时也不能无限刷。 */
const REMOVE_LIMIT = 30;
const REMOVE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 撤销一条排除＝允许这句话重新被自动记住。
 *
 * 这个入口不是可选的装饰：一条没有任何界面能解开的静默永久封禁比假开关更糟，
 * 用户会发现自己说过的话 AI 再也记不住，而且查不出原因。
 *
 * 没有先查再删：删除条件里带着 session 的 userId，改到 0 行就是不属于你或者已经不在。
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-exclusion-remove:${user.id}`, REMOVE_LIMIT, REMOVE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const { id } = await ctx.params;

    const removed = await removeExclusion(id, user.id);
    if (!removed) throw new ApiError(404, 'EXCLUSION_NOT_FOUND', '这条排除不存在');

    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.memory_exclusion_remove',
      targetType: 'memory_exclusion',
      targetId: id,
      // 只记 id：被排除的正文与记忆正文同等对待，日志里不复制一份（任务书 5.5）。
      after: { removed: true },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { removed: true };
  });
}
