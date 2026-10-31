import { prisma } from '@/lib/prisma';
import { api, assertSameOrigin, getRequestIp, jsonError, readJson } from '@/lib/http';
import { forgotPasswordSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { hourlyTokenCount, issueEmailToken, secondsUntilResendAllowed } from '@/lib/email-token';
import { emailChannel, sendVerificationEmail } from '@/lib/email';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

/** 不泄露邮箱是否注册，同时如实说明验证码被投递到了哪里。 */
function genericResponse() {
  const channel = emailChannel();
  const where =
    channel === 'console'
      ? '验证码会输出到服务器控制台（当前为开发模式，不会真实发送邮件）'
      : channel === 'file'
        ? '验证码会写入服务器本地邮件目录（当前为测试模式，不会真实发送邮件）'
        : '我们已发送重置验证码，请检查收件箱（含垃圾邮件目录）';
  return { sent: true, channel, message: `如果该邮箱已注册，${where}` };
}

export async function POST(req: Request) {
  return api(async () => {
    assertSameOrigin(req);
    const body = forgotPasswordSchema.parse(await readJson(req));
    const ip = getRequestIp(req);
    const ipLimit = rateLimit(`forgot:ip:${ip}`, 10, 60 * 60 * 1000);
    if (!ipLimit.ok) return jsonError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
    const emailLimit = rateLimit(`forgot:email:${body.email}`, 3, 15 * 60 * 1000);
    if (!emailLimit.ok) return jsonError(429, 'RATE_LIMITED', '该邮箱请求过于频繁，请稍后重试');

    const cooldown = await secondsUntilResendAllowed(body.email, 'RESET');
    if (cooldown > 0) return jsonError(429, 'RESEND_TOO_SOON', `请在 ${cooldown} 秒后重试`);
    if ((await hourlyTokenCount(body.email, 'RESET')) >= 5) {
      return jsonError(429, 'RATE_LIMITED', '该邮箱验证码请求次数过多，请稍后再试');
    }

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && user.status === 'ACTIVE') {
      const issued = await issueEmailToken({
        email: body.email,
        purpose: 'RESET',
        userId: user.id,
        ip
      });
      try {
        await sendVerificationEmail({ to: body.email, code: issued.code, purpose: 'RESET' });
      } catch {
        await prisma.emailToken.update({
          where: { id: issued.token.id },
          data: { consumedAt: new Date() }
        });
        log.warn('auth.forgot_email_failed', { userId: user.id });
      }
    }
    return genericResponse();
  });
}
