import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { addEvidence, listEvidence } from '@/lib/cognitive/capabilities';
export const runtime = 'nodejs';
const input = z.object({
  kind: z.enum(['SELF_REPORT', 'TASK_RESULT']),
  score: z.number().finite().min(0).max(1).nullable().optional(),
  note: z.string().trim().min(1).max(2000),
  observedAt: z.string().datetime().optional(),
  sourceMessageId: z.string().uuid().optional()
}).strict();
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { evidence: await listEvidence(user.id, (await ctx.params).id) };
  });
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    if (!rateLimit('capability-evidence:' + user.id, 100, 3600000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '操作过于频繁');
    }
    return { evidence: await addEvidence(user.id, (await ctx.params).id, input.parse(await readJson(req))) };
  });
}
