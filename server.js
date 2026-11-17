/* eslint-disable no-console */
/**
 * Secure custom server for Family AI Chat.
 *
 * Every request, including Next.js static assets and API routes, passes through
 * the IP allowlist gate before it reaches Next.js. The gate fails closed.
 */
require('dotenv').config();

// Next 选 dev/prod runtime 包只看 NODE_ENV（自定义服务器路径上没人补它），--dev 时钉死，否则终端残留值会让 dev 构建树配上 prod 包而全站 500。
if (process.argv.includes('--dev')) process.env.NODE_ENV = 'development';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { attachGzip } = require('./server-gzip.cjs');
const { loadProxyConfig, matchesCidr, parseCidr, resolveClientIp, setClientIpHeaders } = require('./server-ip.cjs');

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_MS = Math.max(200, Number(process.env.IP_CACHE_MS || 1000));
const APP_IS_HTTPS = String(process.env.APP_URL || '').startsWith('https://');

const prisma = new PrismaClient();

function writeLaunchLog(line) {
  const filename = process.env.AI_WEBCHAT_LAUNCH_LOG;
  if (filename) fs.appendFile(filename, line + '\n', () => {});
}

function log(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level: 'info', event, ...fields });
  console.log(line);
  writeLaunchLog(line);
}
function logErr(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, ...fields });
  console.error(line);
  writeLaunchLog(line);
}

let cache = {
  rules: [],
  loadedAt: 0,
  error: null,
  lastGoodAt: 0
};
let refreshPromise = null;
let ruleTimer = null;

async function loadRules() {
  const now = new Date();
  const rows = await prisma.ipRule.findMany({
    where: {
      enabled: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    select: { id: true, cidr: true, label: true, lastMatchedAt: true }
  });
  const rules = [];
  for (const row of rows) {
    const parsed = parseCidr(row.cidr);
    if (!parsed) {
      if (shouldLog(`ipguard.invalid_rule:${row.id}`, 60_000)) {
        logErr('ipguard.invalid_rule_skipped', { ruleId: row.id });
      }
      continue;
    }
    rules.push({ ...row, parsed });
  }
  const reportLoad = cache.lastGoodAt === 0 || cache.error || cache.rules.length !== rules.length;
  cache = { rules, loadedAt: Date.now(), error: null, lastGoodAt: Date.now() };
  if (reportLoad) log('ipguard.rules_loaded', { count: rules.length });
}

async function refreshRules(force = false) {
  if (!force && Date.now() - cache.loadedAt < CACHE_MS) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      await loadRules();
    } catch (err) {
      const wasUnavailable = Boolean(cache.error);
      cache.error = err instanceof Error ? err.message : String(err);
      cache.loadedAt = Date.now();
      const reportRefresh = shouldLog('ipguard.refresh_failed', 60_000);
      if (!wasUnavailable || reportRefresh) {
        logErr('ipguard.refresh_failed', { error: cache.error, lastGoodAt: cache.lastGoodAt });
      }
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

const logThrottle = new Map();

function shouldLog(key, windowMs) {
  const now = Date.now();
  const prev = logThrottle.get(key) || 0;
  if (now - prev < windowMs) return false;
  logThrottle.set(key, now);
  if (logThrottle.size > 5000) {
    for (const [k, v] of logThrottle) {
      if (now - v > 10 * 60 * 1000) logThrottle.delete(k);
    }
    // 扫描器能在几分钟里造出上万个不同的 IP，按时间清理可能跟不上，
    // 这里直接重建，保证限流表本身不会变成无上限的内存占用。
    if (logThrottle.size > 5000) logThrottle.clear();
  }
  return true;
}

function accessLog(entry) {
  if (!entry.allowed && !allowDeniedTelemetry()) return;
  prisma.ipAccessLog
    .create({
      data: {
        ip: entry.ip.slice(0, 64),
        path: entry.path.slice(0, 512),
        method: entry.method.slice(0, 16),
        allowed: entry.allowed,
        reason: entry.reason ? entry.reason.slice(0, 128) : null,
        userAgent: entry.userAgent ? entry.userAgent.slice(0, 512) : null
      }
    })
    .catch((err) => logErr('ipguard.log_failed', { error: String(err) }));
}

let deniedWindow = 0;
let deniedSamples = 0;
function allowDeniedTelemetry() {
  const second = Math.floor(Date.now() / 1000);
  if (second !== deniedWindow) {
    deniedWindow = second;
    deniedSamples = 0;
  }
  if (deniedSamples >= 10) return false;
  deniedSamples++;
  return true;
}

function deny(res, ip, reason) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>403 · Access denied</title><style>html,body{height:100%;margin:0}body{background:#07090f;color:#e7ecf5;display:grid;place-items:center;font-family:-apple-system,Segoe UI,sans-serif}.box{text-align:center;padding:32px;max-width:520px}h1{font-size:20px;font-weight:600;letter-spacing:.02em;margin:0 0 12px}p{color:#8b96a9;font-size:14px;line-height:1.7;margin:0}code{color:#8ff0d0;font-size:13px}</style></head><body><div class="box"><h1>Access denied</h1><p>当前网络地址不在访问白名单中。此站点仅允许经服务器所有者授权的 IP 访问。</p><p style="margin-top:14px">Your IP: <code>${String(ip || 'unknown').replace(/[^0-9a-fA-F:.]/g, '')}</code></p></div></body></html>`;
  res.writeHead(403, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
  if (shouldLog(`denylog:${ip || 'unknown'}`, 5000) && allowDeniedTelemetry()) {
    log('ipguard.denied', { ip, reason });
  }
}

function unavailable(res, reason) {
  const body = 'Access control temporarily unavailable';
  res.writeHead(503, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Retry-After': '5'
  });
  res.end(body);
  if (shouldLog(`ipguard.denied_unavailable:${reason}`, 60_000)) {
    logErr('ipguard.denied_unavailable', { reason });
  }
}

async function guard(req, res, proxy) {
  const { ip, peer, reason } = resolveClientIp(req, proxy);
  const pathOnly = (req.url || '/').split('?')[0];
  const ua = req.headers['user-agent'] || '';

  if (!ip) {
    if (shouldLog(`invalid:${peer?.ip || 'none'}`, 5000)) {
      accessLog({ ip: peer?.ip || 'unknown', path: pathOnly, method: req.method || '-', allowed: false, reason, userAgent: ua });
    }
    deny(res, peer?.ip, reason);
    return false;
  }

  // 只有「从没成功加载过白名单」时才把请求压在数据库查询上：冷启动宁可多等
  // 也要保持 fail closed。之后由定时器按 CACHE_MS 预热，请求路径不再等 SQL，
  // 被扫描时数据库的查询频率恒定为 1/CACHE_MS，而不是 1/请求。
  if (cache.lastGoodAt === 0) {
    await refreshRules(true);
  }
  if (cache.error && Date.now() - cache.lastGoodAt > 5000) {
    unavailable(res, 'whitelist-db-unavailable');
    return false;
  }

  const matched = cache.rules.find((rule) => matchesCidr(ip, rule.parsed));
  if (!matched) {
    // 按 IP 限流而不是 IP+路径：扫描器能用几千个路径把访问日志表写爆。
    // 记录的是抢到窗口的这一次请求，足够定位来源和意图。
    if (shouldLog(`deny:${ip.ip}`, 5000)) {
      accessLog({ ip: ip.ip, path: pathOnly, method: req.method || '-', allowed: false, reason: reason === 'trusted-proxy' ? 'not-allowlisted' : reason, userAgent: ua });
    }
    deny(res, ip.ip, 'not-allowlisted');
    return false;
  }

  if (shouldLog(`allow:${ip.ip}`, 5 * 60 * 1000)) {
    accessLog({ ip: ip.ip, path: pathOnly, method: req.method || '-', allowed: true, reason: 'allowed', userAgent: ua });
    prisma.ipRule
      .update({ where: { id: matched.id }, data: { lastMatchedAt: new Date() } })
      .catch(() => undefined);
  }

  // Replace any spoofable forwarding headers before the app sees them.
  setClientIpHeaders(req.headers, ip.ip, reason);
  req.headers['x-nonce'] = crypto.randomBytes(16).toString('base64');
  req.clientIp = ip.ip;
  return reason;
}

function addSecurityHeaders(res) {
  const original = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    try {
      if (!res.hasHeader('X-Content-Type-Options')) res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!res.hasHeader('X-Frame-Options')) res.setHeader('X-Frame-Options', 'DENY');
      if (!res.hasHeader('Referrer-Policy')) res.setHeader('Referrer-Policy', 'same-origin');
      if (!res.hasHeader('Permissions-Policy')) {
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
      }
      if (!res.hasHeader('Cross-Origin-Opener-Policy')) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      if (APP_IS_HTTPS && !res.hasHeader('Strict-Transport-Security')) {
        res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      }
    } catch {
      /* headers may already be sent */
    }
    return original.apply(this, args);
  };
}

async function main() {
  const proxy = loadProxyConfig(process.env);
  if (proxy.enabled && process.env.AI_WEBCHAT_WINDOWS_LOCAL === 'false') {
    const address = process.env.APP_URL;
    const url = APP_IS_HTTPS && URL.canParse(address) ? new URL(address) : null;
    if (!url || url.username || url.password) {
      throw new Error('Windows proxy mode requires an HTTPS APP_URL without credentials');
    }
  }
  const { default: next } = await import('next');
  const app = next({ dev: isDev, hostname: HOST, port: PORT });
  const handle = app.getRequestHandler();
  await app.prepare();

  const requestListener = async (req, res) => {
    try {
      const source = await guard(req, res, proxy);
      if (!source) return;
      if (req.url === '/_internal/ip-check') {
        res.writeHead(req.method === 'GET' && source === 'trusted-proxy' ? 204 : 404, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      addSecurityHeaders(res);
      attachGzip(req, res);
      await handle(req, res);
    } catch (err) {
      logErr('server.request_failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Internal Server Error');
      } else {
        res.destroy();
      }
    }
  };

  let server;
  const tlsKey = process.env.TLS_KEY_FILE;
  const tlsCert = process.env.TLS_CERT_FILE;
  if (tlsKey && tlsCert) {
    server = https.createServer(
      { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert), minVersion: 'TLSv1.2' },
      requestListener
    );
    log('server.tls_enabled');
  } else {
    server = http.createServer(requestListener);
  }

  server.headersTimeout = 30_000;
  server.requestTimeout = 180_000;
  server.keepAliveTimeout = 15_000;

  server.listen(PORT, HOST, () => {
    log('server.listening', { host: HOST, port: PORT, dev: isDev, trustProxy: proxy.enabled });
    refreshRules(true).catch(() => undefined);
    ruleTimer = setInterval(() => void refreshRules(), CACHE_MS);
    ruleTimer.unref();
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('server.shutting_down', { signal });
    if (ruleTimer) clearInterval(ruleTimer);
    server.close(() => log('server.http_closed'));
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logErr('server.start_failed', { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
