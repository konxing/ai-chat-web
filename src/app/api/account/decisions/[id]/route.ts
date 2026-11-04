import { api, ApiError, jsonError, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requireUser } from '@/lib/auth';
import { decisionActionSchema } from '@/lib/validation';
import {
  decisionModuleEnabled,
  getDecisionWithOutcomes,
  setDecisionStatus
} from '@/lib/cognitive/decisions';

export const runtime = 'nodejs';

/** 一小时 30 次：确认/拒绝是状态机推进，不是高频操作；账号被盗时也不能批量洗状态。 */
const DECISION_ACTION_LIMIT = 30;
const DECISION_ACTION_WINDOW_MS = 60 * 60 * 1000;

/** 单条决策和它的结果链接。结果不跟列表一起回：一屏五个列表不需要每条都带结果。 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await decisionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', '决策记忆没有打开；打开后才能查看决策记录');
    }
    const { id } = await ctx.params;
    const found = await getDecisionWithOutcomes(user.id, id);
    if (!found) throw new ApiError(404, 'DECISION_NOT_FOUND', '这条决策不存在');
    return found;
  });
}

/**
 * 确认或拒绝一条决策候选（任务书 5.1「由用户确认后才建立正式决策记录」）。
 *
 * 状态机只有 PENDING_CONFIRM 这一个入口：确认盖 confirmedAt 转 CONFIRMED，
 * 拒绝转 REJECTED 且永远不盖确认时间。并发两次确认只有第一次命中（where 带状态），
 * 第二次是 409 而不是把已确认的行再改一遍。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await decisionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', '决策记忆没有打开；打开后才能确认或拒绝决策候选');
    }
    const limit = rateLimit(`decision-action:${user.id}`, DECISION_ACTION_LIMIT, DECISION_ACTION_WINDOW_MS);
    if (!limit.ok) {
      return jsonError(429, 'RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    }
    const { action } = decisionActionSchema.parse(await readJson(req));
    const { id } = await ctx.params;
    return { decision: await setDecisionStatus(user.id, id, action) };
  });
}
