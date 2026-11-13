const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
process.chdir(root);
const logs = path.join(root, 'dist', 'windows');
fs.mkdirSync(logs, { recursive: true });
const address = 'http://127.0.0.1:3000';
Object.assign(process.env, {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '3000',
  APP_URL: address,
  TRUST_PROXY: 'false',
  COOKIE_SECURE: 'false',
  ALLOW_INSECURE_COOKIES: 'true',
  AI_WEBCHAT_LAUNCH_LOG: path.join(logs, 'backend.log')
});
require('../../server.js');
