/* eslint-disable no-console */
/**
 * Secure custom server for Family AI Chat.
 *
 * Every request, including Next.js static assets and API routes, passes through
 * the IP allowlist gate before it reaches Next.js. The gate fails closed.
 */
require('dotenv').config();

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const ipaddr = require('ipaddr.js');

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_MS = Math.max(200, Number(process.env.IP_CACHE_MS || 1000));
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'true') === 'true';
const APP_IS_HTTPS = String(process.env.APP_URL || '').startsWith('https://');
const TRUSTED_PROXY_CIDRS = String(process.env.TRUSTED_PROXY_CIDRS || '127.0.0.1/32,::1/128')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const prisma = new PrismaClient({ log: ['error'] });

function log(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event, ...fields }));
}
function logErr(event, fields = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, ...fields }));
}

function normalizeIp(input) {
  if (!input) return null;
  let value = String(input).trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!ipaddr.isValid(value)) return null;
  const parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    const v4 = parsed.toIPv4Address();
    return { ip: v4.toNormalizedString(), family: 'ipv4' };
  }
  return { ip: parsed.toNormalizedString(), family: parsed.kind() === 'ipv4' ? 'ipv4' : 'ipv6' };
}

function parseCidr(cidr) {
  try {
    const [addr, prefix] = ipaddr.parseCIDR(cidr.trim());
    return { addr, prefix, family: addr.kind() === 'ipv4' ? 'ipv4' : 'ipv6' };
  } catch {
    return null;
  }
}

const trustedProxies = TRUSTED_PROXY_CIDRS.map(parseCidr).filter(Boolean);

function matchesCidr(parsedIp, rule) {
  if (!rule || rule.family !== parsedIp.family) return false;
  try {
    const addr = ipaddr.parse(parsedIp.ip);
    return addr.match(rule.addr, rule.prefix);
  } catch {
    return false;
  }
}

function isTrusted(peer) {
  return trustedProxies.some((rule) => matchesCidr(peer, rule));
}

function resolveClientIp(req) {
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!peer) return { ip: null, peer: null, reason: 'no-peer-address' };
  if (TRUST_PROXY && isTrusted(peer)) {
    const header = req.headers['x-real-ip'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw) {
      const proxied = normalizeIp(raw.split(',')[0]);
      if (proxied) return { ip: proxied, peer, reason: 'trusted-proxy' };
      return { ip: null, peer, reason: 'invalid-proxy-header' };
    }
  }
  return { ip: peer, peer, reason: 'direct' };
}

let cache = {
  rules: [],
  loadedAt: 0,
  error: null,
  lastGoodAt: 0
};
let refreshPromise = null;

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
      logErr('ipguard.invalid_rule_skipped', { ruleId: row.id });
      continue;
    }
    rules.push({ ...row, parsed });
  }
  cache = { rules, loadedAt: Date.now(), error: null, lastGoodAt: Date.now() };
  log('ipguard.rules_loaded', { count: rules.length });
}

async function refreshRules(force = false) {
  if (!force && Date.now() - cache.loadedAt < CACHE_MS) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      await loadRules();
    } catch (err) {
      cache.error = err instanceof Error ? err.message : String(err);
      cache.loadedAt = Date.now();
      logErr('ipguard.refresh_failed', { error: cache.error, lastGoodAt: cache.lastGoodAt });
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
  }
  return true;
}

function accessLog(entry) {
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
  log('ipguard.denied', { ip, reason });
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
  logErr('ipguard.denied_unavailable', { reason });
}

async function guard(req, res) {
  const { ip, peer, reason } = resolveClientIp(req);
  const pathOnly = (req.url || '/').split('?')[0];
  const ua = req.headers['user-agent'] || '';

  if (!ip) {
    if (shouldLog(`invalid:${peer?.ip || 'none'}`, 5000)) {
      accessLog({ ip: peer?.ip || 'unknown', path: pathOnly, method: req.method || '-', allowed: false, reason, userAgent: ua });
    }
    deny(res, peer?.ip, reason);
    return false;
  }

  await refreshRules();
  if (cache.error && Date.now() - cache.lastGoodAt > 5000) {
    unavailable(res, 'whitelist-db-unavailable');
    return false;
  }

  const matched = cache.rules.find((rule) => matchesCidr(ip, rule.parsed));
  if (!matched) {
    if (shouldLog(`deny:${ip.ip}:${pathOnly}`, 5000)) {
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
  delete req.headers['forwarded'];
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-real-ip'];
  req.headers['x-real-ip'] = ip.ip;
  req.headers['x-client-ip'] = ip.ip;
  req.headers['x-nonce'] = crypto.randomBytes(16).toString('base64');
  req.clientIp = ip.ip;
  return true;
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
  const { default: next } = await import('next');
  const app = next({ dev: isDev, hostname: HOST, port: PORT });
  const handle = app.getRequestHandler();
  await app.prepare();

  const requestListener = async (req, res) => {
    try {
      const allowed = await guard(req, res);
      if (!allowed) return;
      addSecurityHeaders(res);
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
    log('server.listening', { host: HOST, port: PORT, dev: isDev, trustProxy: TRUST_PROXY });
    refreshRules(true).catch(() => undefined);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('server.shutting_down', { signal });
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
