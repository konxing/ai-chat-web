import { prisma } from '@/lib/prisma';
import { api, ApiError, getRequestIp, getUserAgent, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { emailChangeVerifySchema } from '@/lib/validation';
import { EmailCodeError, verifyEmailToken } from '@/lib/email-token';
import { writeAudit } from '@/lib/audit';
import { publicUser } from '@/lib/serializers';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const body = emailChangeVerifySchema.parse(await readJson(req));
    if (body.newEmail === user.email) throw new ApiError(400, 'SAME_EMAIL', '新邮箱与当前邮箱相同');
    let token;
    try {
      token = await verifyEmailToken({ email: body.newEmail, purpose: 'EMAIL_CHANGE', code: body.code });
    } catch (err) {
      if (err instanceof EmailCodeError) throw new ApiError(400, err.code, err.message);
      throw err;
    }
    if (token.userId !== user.id) throw new ApiError(400, 'INVALID_CODE', '验证码无效');
    const existing = await prisma.user.findUnique({ where: { email: body.newEmail } });
    if (existing && existing.id !== user.id) throw new ApiError(409, 'EMAIL_TAKEN', '该邮箱已被其他账号使用');

    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: user.id },
          data: { email: body.newEmail, emailVerified: new Date() }
        });
        await tx.emailToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } });
        return u;
      });
    } catch {
      throw new ApiError(409, 'EMAIL_TAKEN', '该邮箱已被其他账号使用');
    }
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.email_change',
      targetType: 'user',
      targetId: user.id,
      before: { email: user.email },
      after: { email: updated.email },
      ip: getRequestIp(req),
      userAgent: getUserAgent(req)
    });
    return { user: publicUser(updated) };
  });
}
