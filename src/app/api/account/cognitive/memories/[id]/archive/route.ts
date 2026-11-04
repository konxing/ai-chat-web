import { api, ApiError, getRequestIp, getUserAgent, jsonError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { archiveMemory } from '@/lib/cognitive/memories';

export const runtime = 'nodejs';

/** 一小时 60 次：逐条整理一屏记忆是正常动作（列表本身有 200 行的硬上限），不该被卡住。 */
const ARCHIVE_LIMIT = 60;
const ARCHIVE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 归档一条记忆（任务书 7.2 的 ARCHIVE「归档，仍可在允许范围内恢复」）。
 *
 * 和两个邻居的区别都在这条路上看得见：撤回把 origin 覆成 RETRACTED（原值回不来），
 * 永久删除把行删掉；这里只写 archivedAt 一列，正文、证据、演化边、向量全留着。
 * 所以它不要求理由——理由必填是留给那两个不可逆动作的摩擦力，可逆的不该付。
 * 也不写排除规则：写了以后「恢复」会被自动记账挡回去，就成了假动作。
 *
 * 没有先查再改：archiveMemory 的 where 里带着 userId，改到 0 行就是不属于你或者不存在，
 * 两种情况回同一个 404，不给别人枚举你的记忆 id。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-archive:${user.id}`, ARCHIVE_LIMIT, ARCHIVE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const { id } = await ctx.params;

    const archived = await archiveMemory(id, user.id);
    if (!archived) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.memory_archive',
      targetType: 'memory',
      targetId: id,
      // 只记状态：被归档的那句话本身不进审计，跟正文同等对待。
      after: { archived: true },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { archived: true };
  });
}
