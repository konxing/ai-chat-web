import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listEvidence } from '@/lib/cognitive/evidence';

export const runtime = 'nodejs';

/**
 * 一条记忆的证据（任务书 2.2 要求支持证据和反对证据都能被追溯）。
 *
 * 和版本链同一个模式：不跟着列表一次带回来，用户点一次才取一条记忆的。
 * 证据的说明文字是密文，捞多少条就要解多少次，不该为没人看的一屏白解一遍。
 *
 * 刻意不做存在性校验，查不到就返回空数组：用 404 去区分「记忆不存在」和
 * 「还没有证据」，等于开一个探测别人记忆存不存在的口子，而这两种情况界面本来就长一样。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    return { evidence: await listEvidence(id, user.id) };
  });
}
