import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listFailedCognitiveTasks } from '@/lib/cognitive/failed-tasks';

export const runtime = 'nodejs';

/**
 * 「没记上的句子」列表（任务书 §6 要求④「支持失败任务查看」）。只读，没有写入口。
 *
 * 一屏三个调度列的读数：哪次对话（`chatId`）、试了几次、为什么判死。没有正文，也没有消息坐标：
 * 这一行上本来就没有那句话，正文要从 Message 行解密，而会话页也没有「滚到某一句」的锚点，
 * 所以这一屏只把用户带到那次对话门口——要哪一句，他自己认得。
 *
 * **这里不查任何模块开关**，别当成漏掉的闸门补上（裁决同 `memories/route.ts` 头上那段）。
 * 三条理由：
 * 一、这一屏没有模块在运行，读的全是调度列，一行记忆都不解密；
 * 二、失败恰恰发生在「模块开着」的时候，把开关关上再取消这屏的可见性，等于让关掉模块的人
 *     永远不知道自己错过了什么——要求④就只剩运维能满足了；
 * 三、真正的闸门在写侧（`task-worker.ts` 的三值闸门：开关全关时欠账直接作废）。
 * 由 tests/unit/cognitive-failed-tasks-route.test.ts 倒数第二节钉住，探针量过牙齿。
 *
 * 不接查询参数、不限流、不写审计：范围只有「我名下」一种；读的是几张调度行，
 * 不改任何东西、也不解密任何东西，限流只会把「我自己看看漏了什么」变成一次要抢的额度。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return listFailedCognitiveTasks(user.id);
  });
}
