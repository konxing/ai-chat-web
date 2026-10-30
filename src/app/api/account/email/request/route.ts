import { prisma } from '@/lib/prisma';
import { api, ApiError, getRequestIp, getUserAgent, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { emailChangeRequestSchema } from '@/lib/validation';
import { verifyPassword } from '@/lib/password';
import { rateLimit } from '@/lib/rate-limit';
import { issueEmailToken, secondsUntilResendAllowed } from '@/lib/email-token';
import { sendVerificationEmail } from '@/lib/email';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const body = emailChangeRequestSchema.parse(await readJson(req));
    if (body.newEmail === user.email) throw new ApiError(400, 'SAME_EMAIL', '新邮箱与当前邮箱相同');
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) throw new ApiError(403, 'WRONG_PASSWORD', '密码验证失败');
    const limit = rateLimit(`email-change:${user.id}`, 5, 60 * 60 * 1000);
    if (!limit.ok) throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    const cooldown = await secondsUntilResendAllowed(body.newEmail, 'EMAIL_CHANGE');
    if (cooldown > 0) throw new ApiError(429, 'RESEND_TOO_SOON', `请在 ${cooldown} 秒后重试`);
    const existing = await prisma.user.findUnique({ where: { email: body.newEmail } });
    if (existing) throw new ApiError(409, 'EMAIL_TAKEN', '该邮箱已被其他账号使用');

    const issued = await issueEmailToken({
      email: body.newEmail,
      purpose: 'EMAIL_CHANGE',
      userId: user.id,
      ip: getRequestIp(req)
    });
    try {
      await sendVerificationEmail({ to: body.newEmail, code: issued.code, purpose: 'EMAIL_CHANGE' });
    } catch {
      await prisma.emailToken.update({ where: { id: issued.token.id }, data: { consumedAt: new Date() } });
      throw new ApiError(503, 'EMAIL_UNAVAILABLE', '邮件服务暂时不可用');
    }
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.email_change_requested',
      targetType: 'user',
      targetId: user.id,
      ip: getRequestIp(req),
      userAgent: getUserAgent(req),
      after: { newEmail: body.newEmail }
    });
    return { sent: true, expiresIn: 600 };
  });
}
