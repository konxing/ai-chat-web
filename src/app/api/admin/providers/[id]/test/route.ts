import { api, ApiError, jsonError } from '@/lib/http';
import { requireOwner } from '@/lib/auth';
import { testProvider } from '@/lib/providers';
import { rateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { writeAdminAudit } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const limit = rateLimit(`provider-test:${user.id}`, 10, 10 * 60 * 1000);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `测试过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
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
