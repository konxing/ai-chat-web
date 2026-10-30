import { z } from 'zod';

const boolFromString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_SECRET: z.string().min(16),
  MASTER_KEY: z.string().min(1),
  MASTER_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
  MASTER_KEYRING: z.string().optional().default(''),
  COOKIE_SECURE: boolFromString.optional(),
  TRUST_PROXY: boolFromString.default(true),
  TRUSTED_PROXY_CIDRS: z.string().default('127.0.0.1/32,::1/128'),
  IP_CACHE_MS: z.coerce.number().int().min(200).max(60000).default(1000),
  EMAIL_TRANSPORT: z.enum(['smtp', 'console', 'file']).default('console'),
  EMAIL_FROM: z.string().default('Family AI <no-reply@localhost>'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: boolFromString.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  TEST_MAIL_DIR: z.string().optional().default('./test-results/mail'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_PASSPHRASE: z.string().optional().default(''),
  ALLOW_PRIVATE_AI_URLS: boolFromString.default(false),
  ALLOW_INSECURE_COOKIES: boolFromString.default(false),
  NGINX_RELOAD_CMD: z.string().optional().default(''),
  NGINX_ALLOWLIST_PATH: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});

export type AppEnv = z.infer<typeof schema> & {
  masterKeys: Map<string, Buffer>;
  secureCookies: boolean;
};

let cached: AppEnv | null = null;

function decodeKey(value: string, label: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    throw new Error(`${label} must be valid base64`);
  }
  if (buf.length !== 32) throw new Error(`${label} must decode to exactly 32 bytes`);
  return buf;
}

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  const v = parsed.data;

  const masterKeys = new Map<string, Buffer>();
  masterKeys.set(v.MASTER_KEY_ID, decodeKey(v.MASTER_KEY, 'MASTER_KEY'));
  if (v.MASTER_KEYRING.trim()) {
    let ring: Record<string, string>;
    try {
      ring = JSON.parse(v.MASTER_KEYRING) as Record<string, string>;
    } catch {
      throw new Error('MASTER_KEYRING must be valid JSON');
    }
    for (const [id, key] of Object.entries(ring)) {
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) throw new Error(`Invalid key id: ${id}`);
      masterKeys.set(id, decodeKey(key, `MASTER_KEYRING.${id}`));
    }
  }

  const isProd = v.NODE_ENV === 'production';
  const secureCookies = v.COOKIE_SECURE ?? isProd;
  if (isProd && !secureCookies && !v.ALLOW_INSECURE_COOKIES) {
    throw new Error('COOKIE_SECURE must be true in production (or set ALLOW_INSECURE_COOKIES=true only for isolated tests)');
  }
  if (isProd && !/^https:\/\//.test(v.APP_URL) && !v.ALLOW_INSECURE_COOKIES) {
    throw new Error('APP_URL must use https:// in production');
  }
  if (isProd && v.EMAIL_TRANSPORT === 'file') {
    throw new Error('EMAIL_TRANSPORT=file is a test sink and cannot be used in production');
  }
  if (isProd && v.ALLOW_PRIVATE_AI_URLS) {
    console.warn('[env] WARNING: ALLOW_PRIVATE_AI_URLS=true in production. This disables SSRF protection.');
  }

  cached = { ...v, masterKeys, secureCookies };
  return cached;
}

/** Test-only helper. */
export function resetEnvCacheForTests(): void {
  cached = null;
}

export function isProduction(): boolean {
  return loadEnv().NODE_ENV === 'production';
}
