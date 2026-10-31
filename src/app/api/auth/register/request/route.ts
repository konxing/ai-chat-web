import { prisma } from '@/lib/prisma';
import { api, ApiError, assertSameOrigin, getRequestIp, jsonError, readJson } from '@/lib/http';
import { registerRequestSchema } from '@/lib/validation';
import { getSystemSettings } from '@/lib/config';
import { rateLimit } from '@/lib/rate-limit';
import { hourlyTokenCount, issueEmailToken, secondsUntilResendAllowed } from '@/lib/email-token';
import { emailChannel, sendVerificationEmail } from '@/lib/email';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    assertSameOrigin(req);
    const settings = await getSystemSettings();
    if (!settings.registrationOpen) {
      throw new ApiError(403, 'REGISTRATION_CLOSED', '站点当前未开放注册，请联系管理员');
    }
    const body = registerRequestSchema.parse(await readJson(req));
    const ip = getRequestIp(req);
    const ipLimit = rateLimit(`register:ip:${ip}`, 10, 60 * 60 * 1000);
    if (!ipLimit.ok) return jsonError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
    const emailLimit = rateLimit(`register:email:${body.email}`, 3, 15 * 60 * 1000);
    if (!emailLimit.ok) return jsonError(429, 'RATE_LIMITED', '该邮箱请求过于频繁，请稍后重试');

    const existingUsername = await prisma.user.findUnique({ where: { username: body.username } });
    if (existingUsername) throw new ApiError(409, 'USERNAME_TAKEN', '用户名已被占用');
    const existingEmail = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingEmail) throw new ApiError(409, 'EMAIL_TAKEN', '该邮箱已注册');

    const cooldown = await secondsUntilResendAllowed(body.email, 'REGISTER');
    if (cooldown > 0) {
      return jsonError(429, 'RESEND_TOO_SOON', `请在 ${cooldown} 秒后重新获取验证码`);
    }
    if ((await hourlyTokenCount(body.email, 'REGISTER')) >= 5) {
      return jsonError(429, 'RATE_LIMITED', '该邮箱验证码请求次数过多，请稍后再试');
    }

    const issued = await issueEmailToken({
      email: body.email,
      purpose: 'REGISTER',
      username: body.username,
      ip
    });
    try {
      await sendVerificationEmail({ to: body.email, code: issued.code, purpose: 'REGISTER' });
    } catch {
      await prisma.emailToken.update({
        where: { id: issued.token.id },
        data: { consumedAt: new Date() }
      });
      throw new ApiError(503, 'EMAIL_UNAVAILABLE', '邮件服务暂时不可用，请联系管理员');
    }
    return { sent: true, expiresIn: 600, channel: emailChannel() };
  });
}
