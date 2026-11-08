import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { markMemoryVerification } from '@/lib/cognitive/memory-verification';
export const runtime = 'nodejs';
const schema = z.object({
  status: z.enum(['UNVERIFIED', 'VERIFIED', 'DISPUTED', 'REFUTED']),
  volatility: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  expiresAt: z.string().datetime().nullable().optional()
}).strict();
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const id = (await ctx.params).id;
    const owned = await prisma.memoryItem.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!owned) throw new ApiError(404, 'MEMORY_NOT_FOUND', '记忆不存在');
    const row = await prisma.memoryVerification.findFirst({ where: { memoryId: id, userId: user.id } });
    return {
      verification: row ? {
        status: row.status, volatility: row.volatility,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        checkedAt: row.checkedAt?.toISOString() ?? null
      } : { status: 'UNVERIFIED', volatility: 'MEDIUM', expiresAt: null, checkedAt: null }
    };
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return markMemoryVerification(user.id, (await ctx.params).id, schema.parse(await readJson(req)));
  });
}
