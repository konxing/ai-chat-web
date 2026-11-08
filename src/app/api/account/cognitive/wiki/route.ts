import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listWikiPages } from '@/lib/cognitive/knowledge-wiki';
export const runtime = 'nodejs';
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { pages: await listWikiPages(user.id) };
  });
}
