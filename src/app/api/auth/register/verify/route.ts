import { prisma } from '@/lib/prisma';
import { api, ApiError, assertSameOrigin, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { registerVerifySchema } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { consumeEmailToken, EmailCodeError, verifyEmailToken } from '@/lib/email-token';
import { passwordPolicyError, hashPassword } from '@/lib/password';
import { createSession, setSessionCookies } from '@/lib/session';
import { publicSettings, publicUser } from '@/lib/serializers';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    assertSameOrigin(req);
    const body = registerVerifySchema.parse(await readJson(req));
    const ip = getRequestIp(req);
    const userAgent = getUserAgent(req);
    const limit = rateLimit(`register-verify:${body.email}`, 10, 15 * 60 * 1000);
    if (!limit.ok) return jsonError(429, 'RATE_LIMITED', '验证码尝试次数过多，请稍后重试');

    let token;
    try {
      token = await verifyEmailToken({ email: body.email, purpose: 'REGISTER', code: body.code });
    } catch (err) {
      if (err instanceof EmailCodeError) throw new ApiError(400, err.code, err.message);
      throw err;
    }
    if (!token.username) throw new ApiError(400, 'INVALID_CODE', '注册信息缺失，请重新获取验证码');
    const policy = passwordPolicyError(body.password, { username: token.username, email: token.email });
    if (policy) throw new ApiError(400, 'WEAK_PASSWORD', policy);

    const duplicate = await prisma.user.findFirst({
      where: { OR: [{ username: token.username }, { email: token.email }] }
    });
    if (duplicate) throw new ApiError(409, 'ACCOUNT_EXISTS', '用户名或邮箱已被注册');

    const passwordHash = await hashPassword(body.password);
    let user;
    try {
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: token.username!,
            email: token.email,
            emailVerified: new Date(),
            passwordHash,
            displayName: token.username,
            role: 'USER',
            status: 'ACTIVE'
          }
        });
        await tx.emailToken.update({
          where: { id: token.id },
          data: { consumedAt: new Date() }
        });
        return created;
      });
    } catch {
      throw new ApiError(409, 'ACCOUNT_EXISTS', '用户名或邮箱已被注册');
    }

    const createdSession = await createSession({ userId: user.id, ip, userAgent });
    await setSessionCookies(createdSession);
    await prisma.loginLog.create({
      data: { userId: user.id, identifier: user.email, ip, userAgent, success: true, reason: 'register' }
    });
    await writeAudit({
      actorId: user.id,
      actorLabel: user.username,
      action: 'user.register',
      targetType: 'user',
      targetId: user.id,
      ip,
      userAgent
    });
    return { user: publicUser(user), settings: await publicSettings() };
  });
}
