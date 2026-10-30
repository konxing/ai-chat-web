import { api, ApiError, assertSameOrigin, jsonError, jsonOk } from '@/lib/http';
import { clearSessionCookies, getSession, revokeSession, verifyCsrfToken } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    assertSameOrigin(req);
    const session = await getSession();
    if (session) {
      if (!verifyCsrfToken(session, req.headers.get('x-csrf-token'))) {
        throw new ApiError(403, 'CSRF_FAILED', '安全令牌校验失败');
      }
      await revokeSession(session.id);
    }
    await clearSessionCookies();
    return jsonOk({ loggedOut: true });
  });
}
