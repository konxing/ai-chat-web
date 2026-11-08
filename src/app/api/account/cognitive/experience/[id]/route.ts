import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { deleteExperience, updateExperience } from '@/lib/cognitive/experience';
export const runtime = 'nodejs';
const patch = z.discriminatedUnion('action', [
  z.object({ action: z.literal('VERIFY'), version: z.number().int().min(1) }),
  z.object({ action: z.literal('REFUTE'), version: z.number().int().min(1) }),
  z.object({
    action: z.literal('EDIT'), version: z.number().int().min(1),
    title: z.string().trim().min(1).max(160).optional(),
    lesson: z.string().trim().min(1).max(2000).optional(),
    validation: z.string().trim().max(1200).nullable().optional()
  })
]);
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { experience: await updateExperience(user.id, (await ctx.params).id, patch.parse(await readJson(req))) };
  });
}
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return deleteExperience(user.id, (await ctx.params).id);
  });
}
