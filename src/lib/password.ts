import argon2 from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP minimum)
  timeCost: 2,
  parallelism: 1
} as const;

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$rxDWlfVmfB1RZNjL11BksA$YcUrZszAZvkHwXtZm3wSieQVRyzGOVhXOE3H9aBAQxg';

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  '12345678901',
  'qwertyuiop',
  'qwerty123456',
  'letmein123',
  'iloveyou123',
  'admin123456',
  'welcome123',
  'changeme123',
  'family1234',
  'abc123456789'
]);

export interface PasswordPolicyContext {
  username?: string;
  email?: string;
}

export function passwordPolicyError(password: string, ctx: PasswordPolicyContext = {}): string | null {
  if (typeof password !== 'string') return '密码格式无效';
  if (password.length < 10) return '密码至少需要 10 个字符';
  if (password.length > 128) return '密码不能超过 128 个字符';
  if (/\s{2,}/.test(password)) return '密码不能包含连续空格';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return '密码过于常见，请更换更强的密码';
  if (ctx.username && lower.includes(ctx.username.toLowerCase())) return '密码不能包含用户名';
  if (ctx.email) {
    const local = ctx.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && lower.includes(local)) return '密码不能包含邮箱前缀';
  }
  const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (categories < 2) return '密码需至少包含字母、数字、符号中的两类';
  return null;
}

export function verifyPasswordPolicy(password: string, ctx?: PasswordPolicyContext): void {
  const err = passwordPolicyError(password, ctx);
  if (err) {
    const e = new Error(err);
    (e as Error & { code?: string }).code = 'WEAK_PASSWORD';
    throw e;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  const target = hash || DUMMY_HASH;
  try {
    const ok = await argon2.verify(target, password);
    return ok && !!hash;
  } catch {
    return false;
  }
}

export function isArgon2idHash(hash: string): boolean {
  return /^\$argon2id\$v=\d+\$/.test(hash);
}
