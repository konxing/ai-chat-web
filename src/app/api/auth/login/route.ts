import { prisma } from '@/lib/prisma';
import { api, ApiError, assertSameOrigin, getRequestIp, getUserAgent, jsonError, readJson } from '@/lib/http';
import { loginSchema } from '@/lib/validation';
import { verifyPassword } from '@/lib/password';
import { rateLimit } from '@/lib/rate-limit';
import { checkLoginLock, clearLoginLock, registerLoginFailure } from '@/lib/login-lock-store';
import { createSession, setSessionCookies } from '@/lib/session';
import { publicSettings, publicUser } from '@/lib/serializers';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return api(async () => {
    assertSameOrigin(req);
    const ip = getRequestIp(req);
    const userAgent = getUserAgent(req);
    const ipLimit = rateLimit(`login:ip:${ip}`, 20, 15 * 60 * 1000);
    if (!ipLimit.ok) {
      return jsonError(429, 'RATE_LIMITED', `尝试次数过多，请在 ${ipLimit.retryAfterSec} 秒后重试`);
    }
    const body = loginSchema.parse(await readJson(req));
    const identifier = body.identifier.toLowerCase();

    // 锁定检查放在 argon2 之前：被锁的 IP 不再消耗密码哈希的 CPU。
    const lock = await checkLoginLock(ip);
    if (lock.locked) {
      await prisma.loginLog.create({
        data: { identifier: body.identifier.slice(0, 254), ip, userAgent, success: false, reason: 'locked' }
      });
      return jsonError(
        429,
        'LOGIN_LOCKED',
        `该网络连续输错密码次数过多，请在 ${lock.retryAfterSec} 秒后重试，或联系管理员解除锁定`
      );
    }

    const idLimit = rateLimit(`login:id:${identifier}`, 8, 15 * 60 * 1000);
    if (!idLimit.ok) {
      return jsonError(429, 'RATE_LIMITED', `该账号尝试次数过多，请在 ${idLimit.retryAfterSec} 秒后重试`);
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ username: body.identifier }, { email: identifier }]
      }
    });
    const passwordOk = await verifyPassword(user?.passwordHash ?? null, body.password);

    if (!user || !passwordOk) {
      await prisma.loginLog.create({
        data: {
          userId: user?.id ?? null,
          identifier: body.identifier.slice(0, 254),
          ip,
          userAgent,
          success: false,
          reason: user ? 'bad_password' : 'unknown_user'
        }
      });
      const verdict = await registerLoginFailure(ip);
      if (verdict.locked) {
        return jsonError(
          429,
          'LOGIN_LOCKED',
          `密码错误次数过多，该网络已被锁定，请在 ${verdict.retryAfterSec} 秒后重试或联系管理员解除`
        );
      }
      return jsonError(
        401,
        'INVALID_CREDENTIALS',
        `用户名/邮箱或密码错误，本网络还可尝试 ${verdict.attemptsLeft} 次`
      );
    }
    if (user.status !== 'ACTIVE') {
      await prisma.loginLog.create({
        data: { userId: user.id, identifier: body.identifier.slice(0, 254), ip, userAgent, success: false, reason: 'disabled' }
      });
      throw new ApiError(403, 'ACCOUNT_DISABLED', '账号已被禁用，请联系管理员');
    }

    await clearLoginLock(ip);
    const created = await createSession({ userId: user.id, ip, userAgent });
    await setSessionCookies(created);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });
    await prisma.loginLog.create({
      data: { userId: user.id, identifier: body.identifier.slice(0, 254), ip, userAgent, success: true, reason: null }
    });
    if (user.role === 'OWNER') {
      await writeAudit({
        actorId: user.id,
        actorLabel: user.username,
        action: 'owner.login',
        targetType: 'session',
        targetId: created.session.id,
        ip,
        userAgent
      });
    }
    return { user: publicUser(updated), settings: await publicSettings() };
  });
}
