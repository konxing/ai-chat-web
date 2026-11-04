import { api, ApiError, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { reflectionActionSchema } from '@/lib/validation';
import {
  getReflectionWithCitations,
  reflectionGates,
  reflectionModuleEnabled,
  setReflectionStatus
} from '@/lib/cognitive/reflections';

export const runtime = 'nodejs';

/** 一小时 30 次：状态机推进不是高频操作，账号被盗时也不能批量洗洞察。 */
const REFLECTION_ACTION_LIMIT = 30;
const REFLECTION_ACTION_WINDOW_MS = 60 * 60 * 1000;

/**
 * 一条洞察和它的证据（任务书 6.4 的「点开看原话」）。
 *
 * 读不到就是 404，不区分「有但不是你的」：后者会把别人的 id 变成一次可确认的信息。
 * 证据正文在这里才解密——列表那一屏只解标题和正文，点开才付引用那几行的解密钱。
 *
 * 因此这里有两道闸门：洞察自己的开关，加上那份证据所属的长期记忆开关。关掉长期记忆后再点开详情
 * 照样能把记忆原文解出来，等于给派生视图留了一条绕过模块开关的后门（任务书 1.1）。
 * 列表和 PATCH 只读 ReflectionRecord 自己的列，不读记忆行，所以它们只过第一道。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const gates = await reflectionGates(user.id);
    if (!gates.reflectionEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', 'AI 主动洞察没有打开；打开后才能查看洞察和它的证据');
    }
    if (!gates.memoryEnabled) {
      throw new ApiError(
        409,
        'MODULE_DISABLED',
        '长期记忆没有打开；洞察的证据就是记忆原文，关掉后这里不读取证据正文'
      );
    }
    const { id } = await ctx.params;
    const found = await getReflectionWithCitations(user.id, id, { now: new Date() });
    if (!found) throw new ApiError(404, 'REFLECTION_NOT_FOUND', '这条洞察不存在');
    return found;
  });
}

/**
 * 用户对一条洞察的动作：采纳 / 忽略 / 改 / 稍后（任务书 6.4 的状态机）。
 *
 * 采纳不写记忆也不改画像——这是 6-B 立项时定下的甲方案，服务层里那条禁令
 * 由 tests/unit/cognitive-reflection-states.test.ts 钉成静态断言。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await reflectionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', 'AI 主动洞察没有打开；打开后才能处理洞察');
    }
    const limit = rateLimit(`reflection-action:${user.id}`, REFLECTION_ACTION_LIMIT, REFLECTION_ACTION_WINDOW_MS);
    if (!limit.ok) {
      return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    }
    const action = reflectionActionSchema.parse(await readJson(req));
    const { id } = await ctx.params;
    return { reflection: await setReflectionStatus(user.id, id, { ...action, now: new Date() }) };
  });
}
