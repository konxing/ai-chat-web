import { api, ApiError, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { testProvider } from '@/lib/providers';
import { rateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const limit = rateLimit(`provider-test:${user.id}`, 10, 10 * 60 * 1000);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `测试过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const body = await readJson<{ id?: string }>(req);
    if (!body.id) throw new ApiError(400, 'MISSING_ID', '缺少模型配置 ID');
    const provider = await prisma.aiProvider.findFirst({
      where: { id: body.id, ownerType: 'USER', userId: user.id }
    });
    if (!provider) throw new ApiError(404, 'PROVIDER_NOT_FOUND', '模型配置不存在');
    return testProvider(provider);
  });
}
