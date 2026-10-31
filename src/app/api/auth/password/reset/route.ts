import { prisma } from '@/lib/prisma';
import { api, ApiError, assertSameOrigin, getRequestIp, jsonError, readJson } from '@/lib/http';
import { resetPasswordSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { EmailCodeError, verifyEmailToken } from '@/lib/email-token';
import { hashPassword, passwordPolicyError } from '@/lib/password';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    assertSameOrigin(req);
    const body = resetPasswordSchema.parse(await readJson(req));
    const ip = getRequestIp(req);
    const limit = rateLimit(`reset:${body.email}`, 10, 15 * 60 * 1000);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', '尝试次数过多，请稍后重试');

    let token;
    try {
      token = await verifyEmailToken({ email: body.email, purpose: 'RESET', code: body.code });
    } catch (err) {
      if (err instanceof EmailCodeError) throw new ApiError(400, err.code, err.message);
      throw err;
    }
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    // 被停用的账号不得通过重置自助恢复：与验证码无效走同一分支，避免泄露账号状态。
    if (!user || user.status !== 'ACTIVE') throw new ApiError(400, 'INVALID_CODE', '验证码无效');
    const policy = passwordPolicyError(body.password, { username: user.username, email: user.email });
    if (policy) throw new ApiError(400, 'WEAK_PASSWORD', policy);

    const passwordHash = await hashPassword(body.password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() }
      }),
      prisma.emailToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } }),
      prisma.auditLog.create({
        data: {
          actorId: user.id,
          actorLabel: user.username,
          action: 'user.password_reset',
          targetType: 'user',
          targetId: user.id,
          ip,
          status: 'SUCCESS',
          after: { allSessionsRevoked: true }
        }
      })
    ]);
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'auth.password_reset_completed',
      targetType: 'user',
      targetId: user.id,
      ip
    });
    return { reset: true };
  });
}
