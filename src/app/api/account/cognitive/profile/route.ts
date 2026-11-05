import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';
import { profileEntrySchema } from '@/lib/validation';
import { profileGates, readProfileScreen } from '@/lib/cognitive/profile-reads';
import { clearProfileEntries, createProfileEntry } from '@/lib/cognitive/user-profile';

export const runtime = 'nodejs';

/**
 * 用户画像（任务书 8.2 那一屏的后端）。
 *
 * 闸门在第一句：这一屏读三种密文（画像正文、记忆正文、洞察标题），写的也是密文。
 * `userModelEnabled` 晚一步判断，就等于给一个关了画像的用户解密整屏，或者往库里落一行他不想要的内容。
 * 候选那两路还要不要读记忆行、洞察行，是服务层按 `gates` 里另外两道决定的（profile-reads.ts 文件头），
 * 路由只负责把「这一屏开不开」和身份定下来。
 *
 * 写入只有一扇门：`content` + 两份来源 id。确认时间不在里面——服务层的入参类型里就没有这个字段，
 * 白名单也不收，从请求体编一个「我去年就确认过」这条路不存在。
 *
 * 清空全部是面板上那个**明确的**入口，和「清空全部长期记忆」是两件事：画像条目是你确认过的东西，
 * 不跟着记忆的忘记路径走（任务书 8.2 的边界），所以它只在这三个动词里被动，别处一行都不删。
 */

const READ_DISABLED = '用户画像没有打开；打开后这里才会读取并展示你的画像';
const WRITE_DISABLED = '用户画像没有打开；打开后才能写入或修改画像';

/** 逐条写入一小时 60 次（确认候选是手点，够快但不必无限），清空一小时 3 次——一次不可逆的大动作。 */
const PROFILE_WRITE_LIMIT = 60;
const PROFILE_CLEAR_LIMIT = 3;
const PROFILE_WINDOW_MS = 60 * 60 * 1000;

export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const gates = await profileGates(user.id);
    if (!gates.userModelEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', READ_DISABLED);
    }
    return readProfileScreen(user.id, new Date(), gates);
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    await assertWritable(user.id);
    const limit = rateLimit(`profile-create:${user.id}`, PROFILE_WRITE_LIMIT, PROFILE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);

    const body = profileEntrySchema.parse(await readJson(req));
    const entry = await createProfileEntry({
      userId: user.id,
      content: body.content,
      sourceMemoryIds: body.sourceMemoryIds,
      sourceReflectionIds: body.sourceReflectionIds
    });
    // 审计里只有条目 id 和来源条数：正文是用户的话，不进日志也不进审计（任务书 5.5）。
    await audit(req, user, 'user.profile_create', entry.id, {
      memories: body.sourceMemoryIds?.length ?? 0,
      reflections: body.sourceReflectionIds?.length ?? 0
    });
    return { entry };
  });
}

export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    await assertWritable(user.id);
    const limit = rateLimit(`profile-clear:${user.id}`, PROFILE_CLEAR_LIMIT, PROFILE_WINDOW_MS);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);

    const cleared = await clearProfileEntries(user.id);
    await audit(req, user, 'user.profile_clear', user.id, { cleared }, 'user');
    return { cleared };
  });
}

async function assertWritable(userId: string): Promise<void> {
  const gates = await profileGates(userId);
  if (!gates.userModelEnabled) {
    throw new ApiError(409, 'MODULE_DISABLED', WRITE_DISABLED);
  }
}

async function audit(
  req: Request,
  user: { id: string; username: string },
  action: string,
  targetId: string,
  after: Record<string, number>,
  targetType = 'profile'
): Promise<void> {
  await writeAudit({
    actorId: user.id,
    actorLabel: user.username,
    action,
    targetType,
    targetId,
    after,
    ip: getRequestIp(req),
    userAgent: getUserAgent(req)
  });
}
