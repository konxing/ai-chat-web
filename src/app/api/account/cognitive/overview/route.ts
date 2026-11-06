import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getCognitiveOverview } from '@/lib/cognitive/overview';

export const runtime = 'nodejs';

/**
 * 认知中心门厅的读口（任务书 8.2 那一屏的后端）。只读，没有写入口，也没有身份参数——用户只来自 session。
 *
 * 这一屏**不会因为模块关着而报错**，这是有意的：门厅没有自己的数据，它要做的只是把
 * 「这一屏没打开」那句话和「打开后有」的空位一起端出来。拿 409 挡住整个门厅，
 * 等于让用户找不到那七个开关各在哪一屏打开——8.3 要的是能设置，不是被拦在门外。
 * 真正的闸门在服务层 `overview.ts` 里：那些表一次 `count` 都没被问过。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return getCognitiveOverview(user.id);
  });
}
