import { api, jsonError } from '@/lib/http';
import { getSession } from '@/lib/session';
import { publicSettings, publicUser } from '@/lib/serializers';

export const runtime = 'nodejs';

export async function GET() {
  return api(async () => {
    const session = await getSession();
    if (!session) return jsonError(401, 'UNAUTHENTICATED', '未登录');
    return { user: publicUser(session.user), settings: await publicSettings() };
  });
}
