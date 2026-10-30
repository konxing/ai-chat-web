import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listAttachmentLibrary } from '@/lib/chats';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { attachments: await listAttachmentLibrary(user.id) };
  });
}
