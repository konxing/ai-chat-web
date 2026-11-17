const { isIP } = require('node:net');
const ipaddr = require('ipaddr.js');

const cloudflareHeaders = new Set(['cf-connecting-ip', 'cf-connecting-ipv6', 'cf-pseudo-ipv4', 'cf-worker']);
const pseudoIpv4Range = parseCidr('240.0.0.0/4');
const crossZoneWorkerIp = normalizeIp('2a06:98c0:3600::103').ip;

function normalizeIp(input) {
  if (!input) return null;
  const value = input.split('%')[0];
  if (!isIP(value)) return null;
  let parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  return { ip: parsed.toNormalizedString(), family: parsed.kind() };
}

function parseCidr(cidr) {
  try {
    const [addr, prefix] = ipaddr.parseCIDR(cidr.trim());
    return { addr, prefix, family: addr.kind() };
  } catch {
    return null;
  }
}

function matchesCidr(parsedIp, rule) {
  return rule.family === parsedIp.family && ipaddr.parse(parsedIp.ip).match(rule.addr, rule.prefix);
}

function isForwardingHeader(name) {
  return name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-') ||
    cloudflareHeaders.has(name);
}

function isLoopback(address) {
  return address.family === 'ipv4' ? address.ip.startsWith('127.') : address.ip === '0:0:0:0:0:0:0:1';
}

function loadProxyConfig({
  TRUST_PROXY, TRUSTED_PROXY_CIDRS, AI_WEBCHAT_WINDOWS_LOCAL, WINDOWS_PROXY_PROVIDER, APP_URL, HOST, PORT
}) {
  if (TRUST_PROXY === undefined || TRUST_PROXY === 'false' || TRUST_PROXY === '0') {
    const localHosts = AI_WEBCHAT_WINDOWS_LOCAL === 'true'
      ? new Set(['127.0.0.1', 'localhost'].map((host) => `${host}:${PORT || 3000}`))
      : null;
    return { enabled: false, peers: [], localHosts };
  }
  if (TRUST_PROXY !== 'true' && TRUST_PROXY !== '1') {
    throw new Error('TRUST_PROXY must be true or false');
  }
  const entries = (TRUSTED_PROXY_CIDRS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const peers = entries.map((entry) => {
    const rule = parseCidr(entry);
    if (!rule || rule.prefix === 0 || !isIP(entry.split('/')[0])) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain valid, restricted CIDRs');
    }
    return rule;
  });
  if (!peers.length) throw new Error('TRUST_PROXY requires explicit TRUSTED_PROXY_CIDRS');

  const provider = AI_WEBCHAT_WINDOWS_LOCAL === 'false'
    ? WINDOWS_PROXY_PROVIDER?.trim() || 'generic'
    : 'generic';
  if (provider === 'generic') return { enabled: true, peers, localHosts: null };
  if (provider !== 'cloudflare') throw new Error('WINDOWS_PROXY_PROVIDER must be generic or cloudflare.');
  if (HOST !== '127.0.0.1' || entries.some((entry) => entry !== '127.0.0.1/32')) {
    throw new Error('Windows Cloudflare Tunnel mode requires a same-host IPv4 connector and TRUSTED_PROXY_CIDRS=127.0.0.1/32.');
  }
  let site;
  try {
    site = new URL(APP_URL);
  } catch {
    throw new Error('Cloudflare Tunnel mode requires APP_URL set to the public HTTPS site origin.');
  }
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.hash ||
      site.username || site.password || isIP(site.hostname) || !site.hostname.includes('.')) {
    throw new Error('Cloudflare Tunnel mode requires APP_URL set to the public HTTPS site origin.');
  }
  return {
    enabled: true, peers, localHosts: null, cloudflareHost: site.host,
    cloudflareHealthHost: `127.0.0.1:${PORT || 3000}`
  };
}

function resolveClientIp(req, config) {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!peer) return { ip: null, peer, reason: 'no-peer-address' };
  const forwarded = Object.keys(req.headers).some(isForwardingHeader);
  if (!config.enabled) {
    if (forwarded) return { ip: null, peer, reason: 'unexpected-forwarding-headers' };
    if (config.localHosts) {
      const { host, origin } = req.headers;
      if (!isLoopback(peer) || !config.localHosts.has(host) || (origin !== undefined && origin !== `http://${host}`)) {
        return { ip: null, peer, reason: 'non-local-request-target' };
      }
    }
    return { ip: peer, peer, reason: 'direct' };
  }

  // The launcher and Docker check only status over loopback. All application
  // traffic in proxy mode must come through an explicitly trusted proxy.
  const healthProbe = req.method === 'GET' && req.url === '/api/health';
  const localHealthHost = !config.cloudflareHost || req.headers.host === config.cloudflareHealthHost;
  if (!forwarded && isLoopback(peer) && healthProbe && localHealthHost) {
    return { ip: peer, peer, reason: 'local-health-probe' };
  }
  if (!config.peers.some((rule) => matchesCidr(peer, rule))) {
    return { ip: null, peer, reason: 'untrusted-proxy-peer' };
  }
  const cloudflareHost = config.cloudflareHost;
  if (cloudflareHost) {
    if (typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== cloudflareHost) {
      return { ip: null, peer, reason: 'cloudflare-host-mismatch' };
    }
    // Cloudflare marks Worker fetch subrequests. Same-zone Workers may rewrite the client identity.
    if (req.headers['cf-worker'] !== undefined) {
      return { ip: null, peer, reason: 'cloudflare-worker-unsupported' };
    }
  }
  const header = req.headers[cloudflareHost ? 'cf-connecting-ip' : 'x-real-ip'];
  const raw = typeof header === 'string' ? header.trim() : '';
  if (!raw || raw.includes('%') || !isIP(raw)) {
    return { ip: null, peer, reason: cloudflareHost ? 'invalid-cloudflare-client-ip' : 'invalid-proxy-header' };
  }
  const ip = normalizeIp(raw);
  if (cloudflareHost && ip.ip === crossZoneWorkerIp) {
    return { ip: null, peer, reason: 'cloudflare-worker-unsupported' };
  }
  if (cloudflareHost && matchesCidr(ip, pseudoIpv4Range)) {
    return { ip: null, peer, reason: 'cloudflare-pseudo-ipv4' };
  }
  const gateProbe = req.method === 'GET' && req.url === '/_internal/ip-check';
  if (isLoopback(ip) && (cloudflareHost || (!healthProbe && !gateProbe))) {
    return { ip: null, peer, reason: 'proxied-loopback-client' };
  }
  return { ip, peer, reason: 'trusted-proxy' };
}

function setClientIpHeaders(headers, ip, source) {
  const scheme = headers['x-forwarded-proto'];
  for (const header of Object.keys(headers)) {
    if (isForwardingHeader(header)) delete headers[header];
  }
  if (source === 'trusted-proxy' && (scheme === 'http' || scheme === 'https')) {
    headers['x-forwarded-proto'] = scheme;
  }
  headers['x-real-ip'] = ip;
  headers['x-client-ip'] = ip;
}

module.exports = { loadProxyConfig, matchesCidr, parseCidr, resolveClientIp, setClientIpHeaders };
