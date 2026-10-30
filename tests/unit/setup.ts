/* Deterministic, non-secret environment for unit tests. */
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:5432/unit_test?schema=public';
process.env.APP_URL = 'http://127.0.0.1:3000';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3000';
process.env.APP_SECRET = 'unit-test-app-secret-value-0123456789';
process.env.MASTER_KEY_ID = 'test1';
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MASTER_KEYRING = '';
process.env.TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128';
process.env.TRUST_PROXY = 'true';
process.env.EMAIL_TRANSPORT = 'console';
process.env.UPLOAD_DIR = './test-results/unit-uploads';
process.env.BACKUP_DIR = './test-results/unit-backups';
process.env.ALLOW_PRIVATE_AI_URLS = 'false';
process.env.ALLOW_INSECURE_COOKIES = 'true';
process.env.COOKIE_SECURE = 'false';
process.env.LOG_LEVEL = 'error';
