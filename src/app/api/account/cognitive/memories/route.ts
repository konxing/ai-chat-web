import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listMemories } from '@/lib/cognitive/memories';

export const runtime = 'nodejs';

/**
 * 我的记忆列表（任务书 8.2「记忆管理」）。正文是服务层解了密才回来的，收件人只有 session 里这一个用户。
 *
 * 这里不接任何查询参数：过滤、翻页多一个入口，就多一条通向别人账号的路，
 * 而当前有效的那几十条本来就一次读得完。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { memories: await listMemories(user.id) };
  });
}
