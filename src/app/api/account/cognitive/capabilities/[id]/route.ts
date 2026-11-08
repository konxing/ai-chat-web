import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { updateDimension, deleteDimension } from '@/lib/cognitive/capabilities';
export const runtime = 'nodejs';
const patch = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  goal: z.string().trim().max(1000).nullable().optional(),
  enabled: z.boolean().optional()
}).strict();
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    return { dimension: await updateDimension(user.id, id, patch.parse(await readJson(req))) };
  });
}
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return deleteDimension(user.id, (await ctx.params).id);
  });
}
