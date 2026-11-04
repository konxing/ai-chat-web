import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { reflectionStatusSchema } from '@/lib/validation';
import {
  REFLECTION_LIST_MAX_ROWS,
  listReflections,
  reflectionModuleEnabled
} from '@/lib/cognitive/reflections';

export const runtime = 'nodejs';

/**
 * 洞察列表（任务书 6.4 那一屏的后端）。只读，改状态走 [id]。
 *
 * 闸门在最前面：reflectionEnabled 关着连一行都不捞——和认知时间线、决策列表同一个口径。
 * 这一屏读的是**密文**，闸门晚一步就意味着给一个关了反思的用户整屏解密。
 *
 * `state` 是一个可选的枚举过滤，不是「界面自己筛」的替身：派生状态（过期）在服务层算，
 * 所以过滤也在服务层，路由只负责把不认识的词挡在 400。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!(await reflectionModuleEnabled(user.id))) {
      throw new ApiError(409, 'MODULE_DISABLED', 'AI 主动洞察没有打开；打开后这里才会读取并展示你的洞察');
    }
    const raw = new URL(req.url).searchParams.get('state');
    const state = raw === null ? undefined : reflectionStatusSchema.parse(raw);
    const reflections = await listReflections(user.id, { now: new Date(), state });
    return { reflections, capped: reflections.length >= REFLECTION_LIST_MAX_ROWS };
  });
}
