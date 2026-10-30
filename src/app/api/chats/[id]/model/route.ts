import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { chatModelSchema } from '@/lib/validation';
import { setChatModel } from '@/lib/chats';
import { getProviderForUser } from '@/lib/providers';

export const runtime = 'nodejs';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { user } = await requireUser(req);
    const { id } = await ctx.params;
    const body = chatModelSchema.parse(await readJson(req));
    const provider = await getProviderForUser(body.providerId, user.id);
    await setChatModel(id, user.id, provider);
    return { providerId: provider.id, modelId: provider.modelId, providerName: provider.name };
  });
}
