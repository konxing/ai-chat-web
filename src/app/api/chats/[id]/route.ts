import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { chatRenameSchema } from '@/lib/validation';
import { deleteChat, getChatDetail, renameChat } from '@/lib/chats';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    return { chat: await getChatDetail(id, user.id) };
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const body = chatRenameSchema.parse(await readJson(req));
    const chats = await renameChat(id, user.id, body.title);
    return { chats };
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    await deleteChat(id, user.id);
    return { deleted: true };
  });
}
