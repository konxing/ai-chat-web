import { api, ApiError, jsonError, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireUser } from '@/lib/auth';
import { outcomeLinkSchema } from '@/lib/validation';
import { decisionModuleEnabled, setOutcomeLink } from '@/lib/cognitive/decisions';

export const runtime = 'nodejs';

/** 和决策确认同一个量级：链接确认是低频动作，限流只为账号被盗时不能批量洗状态。 */
const OUTCOME_LINK_LIMIT = 30;
const OUTCOME_LINK_WINDOW_MS = 60 * 60 * 1000;

/**
 * 确认或解除一条结果候选链接（任务书 5.3）。
 *
 * 后台只敢提候选：把「结果不好」归因到某条决策上是用户的判断，不是词法匹配的判断。
 * 这里就是那个判断的入口，状态机只允许从 CANDIDATE 出发（服务层 where 里带着）。
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; outcomeId: string }> }
) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await decisionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', '决策记忆没有打开；打开后才能确认或解除结果链接');
    }
    const limit = rateLimit(`outcome-link:${user.id}`, OUTCOME_LINK_LIMIT, OUTCOME_LINK_WINDOW_MS);
    if (!limit.ok) {
      return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    }
    const { action } = outcomeLinkSchema.parse(await readJson(req));
    const { id, outcomeId } = await ctx.params;
    return { outcome: await setOutcomeLink(user.id, id, outcomeId, action) };
  });
}
