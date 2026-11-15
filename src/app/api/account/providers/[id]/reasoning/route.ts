import { requireUser } from '@/lib/auth';
import { api, ApiError } from '@/lib/http';
import { getReasoningOptions } from '@/lib/provider-reasoning';
import { getProviderForUser } from '@/lib/providers';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit(`model-reasoning:${user.id}`, 30, 60_000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '查询过于频繁，请稍后再试');
    }
    const { id } = await ctx.params;
    return getReasoningOptions(await getProviderForUser(id, user.id));
  });
}
