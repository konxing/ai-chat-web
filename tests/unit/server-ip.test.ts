import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Headers = Record<string, string | string[]>;
type Ip = { ip: string; family: string };
type ProxyConfig = { enabled: boolean; peers: unknown[]; localHosts: Set<string> | null };
const { loadProxyConfig, resolveClientIp, setClientIpHeaders } = createRequire(import.meta.url)('../../server-ip.cjs') as {
  loadProxyConfig: (env: Record<string, string | undefined>) => ProxyConfig;
  resolveClientIp: (
    req: { socket: { remoteAddress?: string }; headers: Headers; method: string; url: string },
    proxy: ProxyConfig
  ) => { ip: Ip | null; peer: Ip | null; reason: string };
  setClientIpHeaders: (headers: Headers, ip: string, source: string) => void;
};

const direct = loadProxyConfig({});
const windows = loadProxyConfig({ AI_WEBCHAT_WINDOWS_LOCAL: 'true', PORT: '3000' });
const proxy = loadProxyConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128,192.0.2.30/32' });

function request(remoteAddress: string, headers: Headers = {}, url = '/login', method = 'GET') {
  return { socket: { remoteAddress }, headers, method, url };
}

describe('client IP at the server boundary', () => {
  it('defaults to the TCP peer and supports IPv4-mapped sockets', () => {
    expect(resolveClientIp(request('::ffff:127.0.0.1'), direct)).toMatchObject({
      ip: { ip: '127.0.0.1', family: 'ipv4' }, reason: 'direct'
    });
  });

  it('refuses forwarding metadata in direct mode', () => {
    expect(resolveClientIp(request('127.0.0.1', { 'x-forwarded-proto': 'https' }), direct)).toMatchObject({
      ip: null, reason: 'unexpected-forwarding-headers'
    });
  });

  it('accepts ordinary Windows browser requests only for local hosts and origins', () => {
    expect(resolveClientIp(request('127.0.0.1', { host: '127.0.0.1:3000' }), windows).reason).toBe('direct');
    expect(resolveClientIp(request('127.0.0.1', { host: 'localhost:3000', origin: 'http://localhost:3000' }), windows).reason).toBe('direct');
    expect(resolveClientIp(request('127.0.0.1', { host: 'chat.example.test' }), windows).ip).toBeNull();
    expect(resolveClientIp(request('127.0.0.1', { host: 'localhost:3000', origin: 'https://chat.example.test' }), windows).ip).toBeNull();
    expect(resolveClientIp(request('192.0.2.42', { host: 'localhost:3000' }), windows).ip).toBeNull();
  });

  it('requires explicit CIDRs for trusted mode', () => {
    expect(() => loadProxyConfig({ TRUST_PROXY: 'true' })).toThrow('explicit');
    expect(() => loadProxyConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })).toThrow('restricted');
  });

  it('accepts a single client address from an explicitly trusted peer', () => {
    expect(resolveClientIp(request('192.0.2.30', { 'x-real-ip': '203.0.113.10' }), proxy)).toMatchObject({
      ip: { ip: '203.0.113.10', family: 'ipv4' }, reason: 'trusted-proxy'
    });
    expect(resolveClientIp(request('192.0.2.42', { 'x-real-ip': '203.0.113.10' }), proxy).ip).toBeNull();
  });

  it.each([
    { value: undefined }, { value: 'unknown' }, { value: '203.0.113.10, 192.0.2.60' },
    { value: ['203.0.113.10', '192.0.2.60'] }
  ])('rejects a missing or ambiguous client address ($value)', ({ value }) => {
      const headers: Headers = value === undefined ? {} : { 'x-real-ip': value };
      expect(resolveClientIp(request('127.0.0.1', headers), proxy)).toMatchObject({
        ip: null, reason: 'invalid-proxy-header'
      });
    });

  it.each(['127.0.0.1', '127.23.4.5', '::1', '::ffff:127.0.0.2'])('isolates proxied loopback %s from auth', (ip) => {
    const headers = { 'x-real-ip': ip };
    expect(resolveClientIp(request('192.0.2.30', headers, '/login'), proxy).ip).toBeNull();
    expect(resolveClientIp(request('192.0.2.30', headers, '/api/auth/login', 'POST'), proxy).ip).toBeNull();
    expect(resolveClientIp(request('192.0.2.30', headers, '/api/health', 'POST'), proxy).ip).toBeNull();
    expect(resolveClientIp(request('192.0.2.30', headers, '/api/health'), proxy).reason).toBe('trusted-proxy');
    expect(resolveClientIp(request('192.0.2.30', headers, '/_internal/ip-check'), proxy).reason).toBe('trusted-proxy');
  });

  it('allows direct read-only status in proxy mode', () => {
    expect(resolveClientIp(request('127.0.0.1', {}, '/api/health'), proxy).reason).toBe('local-health-probe');
    expect(resolveClientIp(request('127.0.0.1', {}, '/_internal/ip-check'), proxy).ip).toBeNull();
    expect(resolveClientIp(request('127.0.0.1', {}, '/api/health', 'POST'), proxy).ip).toBeNull();
  });

  it('sanitizes the headers passed to the app', () => {
    const headers = {
      'x-client-ip': '192.0.2.50', 'x-real-ip': '192.0.2.51', 'x-forwarded-for': '192.0.2.52',
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test'
    };
    setClientIpHeaders(headers, '203.0.113.11', 'trusted-proxy');
    expect(headers).toEqual({ 'x-client-ip': '203.0.113.11', 'x-real-ip': '203.0.113.11', 'x-forwarded-proto': 'https' });
  });
});
