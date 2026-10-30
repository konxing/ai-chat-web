import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { chatCreateSchema } from '@/lib/validation';
import { createChat, listChats } from '@/lib/chats';
import { getProviderForUser, resolveDefaultProvider } from '@/lib/providers';
import { ApiError } from '@/lib/http';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { chats: await listChats(user.id) };
  });
}

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const body = chatCreateSchema.parse(await readJson(req));
    let provider = null;
    if (body.providerId) {
      provider = await getProviderForUser(body.providerId, user.id);
    } else {
      try {
        provider = await resolveDefaultProvider(user.id);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'NO_MODEL') throw err;
      }
    }
    const chat = await createChat({ userId: user.id, provider, title: body.title });
    return {
      chat: {
        id: chat.id,
        title: body.title?.trim() || '新对话',
        modelId: chat.modelId,
        providerId: chat.modelProviderId,
        createdAt: chat.createdAt.toISOString(),
        updatedAt: chat.updatedAt.toISOString()
      }
    };
  });
}
