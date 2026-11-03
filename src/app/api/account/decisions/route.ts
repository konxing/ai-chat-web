import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { decisionStatusSchema } from '@/lib/validation';
import {
  DECISION_LIST_MAX_ROWS,
  decisionModuleEnabled,
  listDecisions
} from '@/lib/cognitive/decisions';

export const runtime = 'nodejs';

/**
 * 决策记录列表（任务书 5.5 五个列表的后端）。只读。
 *
 * 闸门在最前面：decisionMemoryEnabled 关着连一行都不捞（门槛 9 的口径和时间线路由一致），
 * 偏好读不出来按关闭处理。五个列表在前端就是 status 过滤，所以这里只收一个白名单参数。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await decisionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', '决策记忆没有打开；打开后这里才会读取并展示你的决策记录');
    }
    const raw = new URL(req.url).searchParams.get('status');
    const status = raw === null ? undefined : decisionStatusSchema.parse(raw);
    const decisions = await listDecisions(user.id, status ? { status } : {});
    return { decisions, capped: decisions.length >= DECISION_LIST_MAX_ROWS };
  });
}
