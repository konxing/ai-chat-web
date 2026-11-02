import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listExclusions } from '@/lib/cognitive/exclusions';

export const runtime = 'nodejs';

/**
 * 不再会被自动记住的内容（任务书 7.3 的来源排除规则）。
 * 正文是服务层解了密才回来的，收件人只有 session 里这一个用户。
 *
 * 和记忆列表一样不接任何查询参数：多一个入口，就多一条通向别人账号的路，
 * 而这张表本来就有 500 条的硬上限，一次读得完。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { exclusions: await listExclusions(user.id) };
  });
}
