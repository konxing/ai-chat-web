import { api, ApiError } from '@/lib/http';
import { requireOwner } from '@/lib/auth';
import { testProvider } from '@/lib/providers';
import { prisma } from '@/lib/prisma';
import { writeAdminAudit } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const { id } = await ctx.params;
    const provider = await prisma.aiProvider.findFirst({ where: { id, ownerType: 'GLOBAL' } });
    if (!provider) throw new ApiError(404, 'PROVIDER_NOT_FOUND', '全局模型不存在');
    const result = await testProvider(provider);
    await writeAdminAudit(req, user, {
      action: 'admin.provider.test',
      targetType: 'ai_provider',
      targetId: id,
      after: { ok: result.ok, detail: result.detail },
      status: result.ok ? 'SUCCESS' : 'FAILURE'
    });
    return result;
  });
}
