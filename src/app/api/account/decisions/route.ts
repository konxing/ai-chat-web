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
 * 偏好读不出来按关闭处理。
 *
 * `status` 是可选的窄化参数，界面那一屏不用它（五个列表在前端按 status 分组）。
 * 过滤发生在服务层派生之后——「待复盘」在库里没有对应的列值，交给 where 就永远查不到；
 * 代价是它只在最近 100 行里筛，口径同 `/api/account/cognitive/reflections` 的 state。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await decisionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', '决策记忆没有打开；打开后这里才会读取并展示你的决策记录');
    }
    const raw = new URL(req.url).searchParams.get('status');
    const status = raw === null ? undefined : decisionStatusSchema.parse(raw);
    const decisions = await listDecisions(user.id, { now: new Date(), ...(status ? { status } : {}) });
    return { decisions, capped: decisions.length >= DECISION_LIST_MAX_ROWS };
  });
}
