import { randomInt } from 'node:crypto';
import type { EmailToken, EmailTokenPurpose } from '@prisma/client';
import { prisma } from './prisma';
import { hmacHex, safeEqualHex } from './crypto';
import { loadEnv } from './env';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function secret(): Buffer {
  return Buffer.from(loadEnv().APP_SECRET, 'utf8');
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function codeHash(tokenId: string, email: string, purpose: EmailTokenPurpose, code: string): string {
  return hmacHex(secret(), `${tokenId}:${purpose}:${email}:${code}`);
}

export interface IssuedEmailToken {
  token: EmailToken;
  code: string;
}

/** Invalidate previous outstanding codes, then issue a new single-use code. */
export async function issueEmailToken(input: {
  email: string;
  purpose: EmailTokenPurpose;
  username?: string | null;
  userId?: string | null;
  ip?: string | null;
}): Promise<IssuedEmailToken> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  await prisma.emailToken.updateMany({
    where: { email, purpose: input.purpose, consumedAt: null },
    data: { consumedAt: now }
  });
  await prisma.emailToken.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
  });
  const code = generateCode();
  // Create first with a placeholder, then use the generated UUID in the HMAC binding.
  const token = await prisma.emailToken.create({
    data: {
      email,
      purpose: input.purpose,
      codeHash: 'pending',
      username: input.username ?? null,
      userId: input.userId ?? null,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      ip: input.ip?.slice(0, 64) ?? null
    }
  });
  const hash = codeHash(token.id, token.email, token.purpose, code);
  const updated = await prisma.emailToken.update({
    where: { id: token.id },
    data: { codeHash: hash }
  });
  return { token: updated, code };
}

export class EmailCodeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function verifyEmailToken(input: {
  email: string;
  purpose: EmailTokenPurpose;
  code: string;
}): Promise<EmailToken> {
  const email = input.email.trim().toLowerCase();
  const token = await prisma.emailToken.findFirst({
    where: { email, purpose: input.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' }
  });
  if (!token) throw new EmailCodeError('INVALID_CODE', '验证码无效或已过期，请重新获取');
  if (token.expiresAt.getTime() <= Date.now()) {
    throw new EmailCodeError('EXPIRED_CODE', '验证码已过期，请重新获取');
  }
  if (token.attempts >= MAX_ATTEMPTS) {
    throw new EmailCodeError('TOO_MANY_ATTEMPTS', '验证码尝试次数过多，请重新获取');
  }
  await prisma.emailToken.update({
    where: { id: token.id },
    data: { attempts: { increment: 1 } }
  });
  if (!/^\d{6}$/.test(input.code)) {
    throw new EmailCodeError('INVALID_CODE', '验证码格式不正确');
  }
  const expected = codeHash(token.id, token.email, token.purpose, input.code);
  if (!safeEqualHex(expected, token.codeHash)) {
    throw new EmailCodeError('INVALID_CODE', '验证码不正确');
  }
  return token;
}

export async function consumeEmailToken(tokenId: string): Promise<void> {
  await prisma.emailToken.update({
    where: { id: tokenId },
    data: { consumedAt: new Date() }
  });
}

export async function secondsUntilResendAllowed(
  email: string,
  purpose: EmailTokenPurpose
): Promise<number> {
  const latest = await prisma.emailToken.findFirst({
    where: { email: email.trim().toLowerCase(), purpose },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true }
  });
  if (!latest) return 0;
  const elapsed = Date.now() - latest.createdAt.getTime();
  return elapsed >= 60_000 ? 0 : Math.ceil((60_000 - elapsed) / 1000);
}

export async function hourlyTokenCount(email: string, purpose: EmailTokenPurpose): Promise<number> {
  return prisma.emailToken.count({
    where: {
      email: email.trim().toLowerCase(),
      purpose,
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
    }
  });
}
