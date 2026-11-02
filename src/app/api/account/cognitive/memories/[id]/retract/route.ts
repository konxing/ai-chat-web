import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { memoryRetractSchema } from '@/lib/validation';
import { retractMemory } from '@/lib/cognitive/memories';

export const runtime = 'nodejs';

const RETRACT_LIMIT = 20;
const RETRACT_WINDOW_MS = 60 * 60 * 1000;

/**
 * 撤回一条记忆（任务书 2.2 的 RETRACTED）。行和正文都留着，只把来源标成已撤回，
 * 从此不再进当前有效列表，也不再注入提示词——「用户不想让 AI 记着这个」和
 * 「这条从来没存在过」是两件事，后者要靠永久删除，那是另一片。
 *
 * 没有先查再改：retractMemory 的 where 里带着 userId，改到 0 行就是不属于你或者不存在，
 * 两种情况回同一个 404，不给别人枚举你的记忆 id。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-retract:${user.id}`, RETRACT_LIMIT, RETRACT_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const { reason } = memoryRetractSchema.parse(await readJson(req));
    const { id } = await ctx.params;

    const retracted = await retractMemory(id, user.id, reason);
    if (!retracted) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.memory_retract',
      targetType: 'memory',
      targetId: id,
      // 理由本身会复述用户那句话，跟正文同等对待：它已经在加密的演化边里了，日志不复制一份。
      after: { retracted: true },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { retracted: true };
  });
}
