import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { generateCapabilitySuggestion } from '@/lib/cognitive/capability-suggestions';
export const runtime = 'nodejs';
/** The request is an explicit consent to send this dimension's selected evidence to the model. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit('capability-suggest:' + user.id, 5, 3600000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '建议生成过于频繁');
    }
    return { intervention: await generateCapabilitySuggestion(user.id, (await ctx.params).id) };
  });
}
