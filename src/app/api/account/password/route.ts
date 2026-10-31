import { prisma } from '@/lib/prisma';
import { api, ApiError, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { changePasswordSchema } from '@/lib/validation';
import { hashPassword, passwordPolicyError, verifyPassword } from '@/lib/password';
import { rateLimit } from '@/lib/rate-limit';
import { revokeAllSessions } from '@/lib/session';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    const { user, session } = await requireUser(req);
    const body = changePasswordSchema.parse(await readJson(req));
    const limit = rateLimit(`password-change:${user.id}`, 8, 15 * 60 * 1000);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', `尝试过于频繁，请在 ${limit.retryAfterSec} 秒后重试`);
    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw new ApiError(403, 'WRONG_PASSWORD', '当前密码不正确');
    const policy = passwordPolicyError(body.newPassword, { username: user.username, email: user.email });
    if (policy) throw new ApiError(400, 'WEAK_PASSWORD', policy);
    if (body.currentPassword === body.newPassword) {
      throw new ApiError(400, 'SAME_PASSWORD', '新密码不能与当前密码相同');
    }
    const passwordHash = await hashPassword(body.newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    const revoked = await revokeAllSessions(user.id, session.id);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.password_change',
      targetType: 'user',
      targetId: user.id,
      ip: getRequestIp(req),
      userAgent: getUserAgent(req),
      after: { otherSessionsRevoked: revoked }
    });
    return { changed: true, otherSessionsRevoked: revoked };
  });
}
