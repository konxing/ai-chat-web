import { prisma } from '@/lib/prisma';
import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { revokeSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user, session } = await requireUser(req);
    const { id } = await ctx.params;
    if (id === session.id) throw new ApiError(400, 'CURRENT_SESSION', '不能在此处注销当前会话，请使用退出登录');
    const target = await prisma.session.findFirst({ where: { id, userId: user.id } });
    if (!target) throw new ApiError(404, 'SESSION_NOT_FOUND', '会话不存在');
    await revokeSession(id);
    return { revoked: true };
  });
}
