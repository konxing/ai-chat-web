import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { memoryReviseSchema } from '@/lib/validation';
import { getMemory, listMemoryRevisions, reviseMemory, type MemoryDto } from '@/lib/cognitive/memories';
import { purgeMemory } from '@/lib/cognitive/forgetting';
import { learnAfterPurge } from '@/lib/cognitive/policy-learner';

export const runtime = 'nodejs';

/** 一小时 30 次：账号被盗后不能无限造版本，每个版本都要加密一次并留一条边。 */
const REVISE_LIMIT = 30;
const REVISE_WINDOW_MS = 60 * 60 * 1000;

/** 一小时 20 次：永久删除不可逆，但用户逐条清理一屏记忆是正常行为，不能卡得太死。 */
const PURGE_LIMIT = 20;
const PURGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 单条记忆和它的演化边（任务书 2.3 的「保留历史版本」要能被用户自己看到）。
 * 历史版本不一次拉全链：边上有 previousId，前端要看哪一版就再发一次 GET，
 * 于是每一次解密集群都对应一次真实的用户动作。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const memory = await getMemory(id, user.id);
    if (!memory) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    return { memory, revisions: await listMemoryRevisions(id, user.id) };
  });
}

/** 用户亲手更正：写新版本、旧行盖戳、留一条写明理由的边——旧正文一个字节都不动。 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-revise:${user.id}`, REVISE_LIMIT, REVISE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `修改过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const { content, reason } = memoryReviseSchema.parse(await readJson(req));
    const { id } = await ctx.params;

    const before = await getMemory(id, user.id);
    if (!before) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    // 一个字没改就不要开新版本：一条没有信息量的演化会把时间线弄脏，
    // 而且它和新正文一模一样，事后谁也看不出这次到底改了什么。
    if (content === before.content) return { memory: before };

    const memory = await reviseMemory({
      previousId: id,
      userId: user.id,
      content,
      // 用户亲手改的，所以是「已确认」，确认时间就是这一刻。
      // 请求体里没有 origin 和 confirmedAt 的口子：那两样只能由服务端说了算。
      origin: 'userConfirmed',
      confirmedAt: new Date(),
      reason
    });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.memory_revise',
      targetType: 'memory',
      // 记的是用户点进去那一行，不是新建出来的版本：查审计的人手上没有新 id。
      targetId: id,
      before: auditTrace(before),
      after: auditTrace(memory),
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { memory };
  });
}

/**
 * 永久删除一条记忆（任务书 7.2 的 DELETE、7.3 的「忘记某条记忆」）。
 * 和撤回不是一回事：行和正文一起消失，不可恢复。原对话记录不动——
 * 7.3 明确要求区分「忘记记忆」和「删除聊天」，用户只说了前者时不许碰后者。
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`memory-purge:${user.id}`, PURGE_LIMIT, PURGE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `删除过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const { id } = await ctx.params;

    // 先查一次不是为了校验归属（删除语句自带 userId 条件），是为了审计能答出
    // 「删掉的是哪一类、第几版」。代价是多解密一行正文，换一条查得懂的审计。
    const before = await getMemory(id, user.id);
    if (!before) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    const result = await purgeMemory(id, user.id);
    // 学习跑在删除提交之后：证据要先落库才数得到，而且学习失败不能反过来让删除失败。
    const learned = await learnAfterPurge(user.id, result.contexts);

    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.memory_purge',
      targetType: 'memory',
      targetId: id,
      before: auditTrace(before),
      // 只记条数和被收紧的情境枚举：审计里不能出现正文（任务书 5.5）。
      after: { purged: result.purged, learned },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { purged: result.purged, learned };
  });
}

/** 审计用的形状：答得出「哪条、第几版、现在还算不算当前有效」，但不带一个字的正文。 */
function auditTrace(memory: MemoryDto) {
  return {
    id: memory.id,
    version: memory.version,
    type: memory.type,
    context: memory.context,
    origin: memory.origin,
    supersededAt: memory.supersededAt
  };
}
