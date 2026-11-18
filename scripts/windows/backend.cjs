const path = require('node:path');

const root = path.resolve(__dirname, '../..');
process.chdir(root);
require('dotenv').config();
const address = 'http://127.0.0.1:3000';
const useProxy = process.env.WINDOWS_USE_PROXY === 'true';
Object.assign(process.env, {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '3000',
  TRUST_PROXY: useProxy ? 'true' : 'false',
  AI_WEBCHAT_WINDOWS_LOCAL: useProxy ? 'false' : 'true',
  COOKIE_SECURE: useProxy ? 'true' : 'false',
  ALLOW_INSECURE_COOKIES: useProxy ? 'false' : 'true',
  TLS_KEY_FILE: '',
  TLS_CERT_FILE: ''
});
if (!useProxy) {
  process.env.APP_URL = address;
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
}
require('../../server.js');
