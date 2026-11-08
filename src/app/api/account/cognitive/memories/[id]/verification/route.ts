import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { markMemoryVerification } from '@/lib/cognitive/memory-verification';
export const runtime = 'nodejs';
const schema = z.object({
  status: z.enum(['UNVERIFIED', 'VERIFIED', 'DISPUTED', 'REFUTED']),
  volatility: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  expiresAt: z.string().datetime().nullable().optional()
}).strict();
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return markMemoryVerification(user.id, (await ctx.params).id, schema.parse(await readJson(req)));
  });
}
