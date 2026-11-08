import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getCognitivePreferences } from '@/lib/cognitive/preferences';
import { buildWikiDrafts } from '@/lib/cognitive/knowledge-wiki';
import { rateLimit } from '@/lib/rate-limit';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const preferences = await getCognitivePreferences(user.id);
    if (!preferences.memoryEnabled || !preferences.userModelEnabled) {
      throw new ApiError(409, 'MODULE_DISABLED', '请先启用长期记忆和用户画像');
    }
    if (!rateLimit('wiki-build:' + user.id, 4, 3600000).ok) {
      throw new ApiError(429, 'RATE_LIMITED', '知识整理请求过于频繁');
    }
    return { drafts: await buildWikiDrafts(user.id) };
  });
}
