import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { memoryCandidateStatusSchema } from '@/lib/validation';
import { MEMORY_LIST_MAX_ROWS } from '@/lib/cognitive/memories';
import { listCandidates } from '@/lib/cognitive/memory-candidates';

export const runtime = 'nodejs';

/**
 * 待确认列表（任务书 1.2 的 ASK_CONFIRM 那一屏的后端）。只读，答它走 `[id]`。
 *
 * 这一屏**故意不吃 `memoryEnabled`**，和片L 对记忆那一屏的裁决同一个理由，别把它当成漏掉的闸门补上：
 * 这里没有模块在运行，只有用户在自己账号里看一批还没答过的话。关掉长期记忆之后给它们加闸门，
 * 后果是「关了记忆 = 看不见也答不了门口那堆原话」——那些句子还密文存在库里，却再也碰不到。
 * 真正的写在 `[id]` 那一侧：确认这一步会落 MemoryItem，所以它必须过闸门。
 *
 * 默认只列待确认。`status` 是可选过滤，因为「这句为什么不再问了」得有个地方查：
 * 答案就是那一条 REJECTED 行，而它只在 status=rejected 这一档里出现。
 *
 * 正文是服务层逐条解密才回来的，所以上限和 `capped` 与记忆、时间线那几屏同口径：
 * 到顶的那一批不报出来，「这里没有更早的」就会被读成「更早的没发生过」。
 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const raw = new URL(req.url).searchParams.get('status');
    const status = raw === null ? undefined : memoryCandidateStatusSchema.parse(raw);
    const candidates = await listCandidates(user.id, { status });
    return { candidates, capped: candidates.length >= MEMORY_LIST_MAX_ROWS };
  });
}
