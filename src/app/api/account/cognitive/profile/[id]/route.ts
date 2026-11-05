import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { profileReviseSchema } from '@/lib/validation';
import { profileGates } from '@/lib/cognitive/profile-reads';
import { deleteProfileEntry, reviseProfileEntry } from '@/lib/cognitive/user-profile';

export const runtime = 'nodejs';

/**
 * 一条画像条目的改与删（任务书 8.2）。
 *
 * 这一屏没有 GET：整屏那份读走集合路由，单条再读一次只是多一趟解密。
 *
 * 改只有正文这一扇门。来源两份数组不在里面是有理由的：那记的是**你确认那一刻的依据**，
 * 是一个时间戳式的事实——事后把依据换成别的记忆，等于让「我当时是怎么确认的」可以被改写。
 * 依据要是真的没了一条记忆，界面认不出来就让它认不出来（user-profile.ts 文件头）。
 *
 * 删和清空走不同的桶：单条改删一小时 60 次（手点够用），整屏清空在集合路由上另算 3 次。
 * 删不掉和「存在但不是你的」给同一个 404——后者会把别人的 id 变成一次可确认的信息。
 */

const WRITE_DISABLED = '用户画像没有打开；打开后才能写入或修改画像';
const PROFILE_WRITE_LIMIT = 60;
const PROFILE_WINDOW_MS = 60 * 60 * 1000;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    await assertWritable(user.id);
    const limit = rateLimit(`profile-revise:${user.id}`, PROFILE_WRITE_LIMIT, PROFILE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);

    const body = profileReviseSchema.parse(await readJson(req));
    const { id } = await ctx.params;
    const entry = await reviseProfileEntry({ userId: user.id, id, content: body.content });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.profile_revise',
      targetType: 'profile',
      targetId: entry.id,
      after: { edited: 1 },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { entry };
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    await assertWritable(user.id);
    const limit = rateLimit(`profile-delete:${user.id}`, PROFILE_WRITE_LIMIT, PROFILE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);

    const { id } = await ctx.params;
    if (!(await deleteProfileEntry(user.id, id))) {
      throw new ApiError(404, 'PROFILE_NOT_FOUND', '这条画像条目不存在');
    }
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.profile_delete',
      targetType: 'profile',
      targetId: id,
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { deleted: true };
  });
}

async function assertWritable(userId: string): Promise<void> {
  const gates = await profileGates(userId);
  if (!gates.userModelEnabled) {
    throw new ApiError(409, 'MODULE_DISABLED', WRITE_DISABLED);
  }
}
