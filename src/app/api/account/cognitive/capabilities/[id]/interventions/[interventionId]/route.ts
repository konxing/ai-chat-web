import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { deleteIntervention, updateIntervention } from '@/lib/cognitive/interventions';
export const runtime = 'nodejs';
const input = z.object({
  status: z.enum(['ACCEPTED', 'SKIPPED', 'COMPLETED']),
  feedback: z.string().trim().max(2000).nullable().optional(),
  effectiveness: z.number().finite().min(0).max(1).nullable().optional()
}).strict();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; interventionId: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id, interventionId } = await ctx.params;
    return { intervention: await updateIntervention(user.id, id, interventionId,
      input.parse(await readJson(req))) };
  });
}
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; interventionId: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id, interventionId } = await ctx.params;
    return deleteIntervention(user.id, id, interventionId);
  });
}
