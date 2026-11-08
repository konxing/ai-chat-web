import { z } from 'zod';
import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { wikiPageDetail, updateWikiPage, deleteWikiPage } from '@/lib/cognitive/knowledge-wiki';
export const runtime = 'nodejs';
const patch = z.discriminatedUnion('action', [
  z.object({ action: z.literal('CONFIRM'), version: z.number().int().min(1) }),
  z.object({ action: z.literal('RENAME'), version: z.number().int().min(1),
    title: z.string().trim().min(1).max(120) })
]);
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { page: await wikiPageDetail(user.id, (await ctx.params).id) };
  });
}
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { page: await updateWikiPage(user.id, (await ctx.params).id, patch.parse(await readJson(req))) };
  });
}
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    return deleteWikiPage(user.id, (await ctx.params).id);
  });
}
