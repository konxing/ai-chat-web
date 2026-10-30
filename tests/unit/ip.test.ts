import { describe, expect, it } from 'vitest';
import {
  IpMatcher,
  cidrContains,
  isPrivateOrReservedIp,
  isTrustedProxy,
  normalizeCidr,
  normalizeIp,
  parseCidrList
} from '@/lib/ip';

describe('normalizeIp', () => {
  it('canonicalizes IPv4 addresses', () => {
    expect(normalizeIp(' 192.168.1.10 ')).toEqual({ ip: '192.168.1.10', family: 'ipv4' });
    expect(normalizeIp('[127.0.0.1]')).toEqual({ ip: '127.0.0.1', family: 'ipv4' });
    // Leading zeros are ambiguously octal and must be rejected.
    expect(() => normalizeIp('192.168.001.010')).toThrow();
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:192.0.2.128')).toEqual({ ip: '192.0.2.128', family: 'ipv4' });
    expect(normalizeIp('::ffff:c000:0280')).toEqual({ ip: '192.0.2.128', family: 'ipv4' });
  });

  it('canonicalizes IPv6 addresses and strips zones', () => {
    expect(normalizeIp('2001:0DB8:0:0:0:0:0:1')).toEqual({ ip: '2001:db8::1', family: 'ipv6' });
    expect(normalizeIp('fe80::1%eth0')).toEqual({ ip: 'fe80::1', family: 'ipv6' });
    expect(normalizeIp('[::1]')).toEqual({ ip: '::1', family: 'ipv6' });
  });

  it('rejects invalid values', () => {
    expect(() => normalizeIp('')).toThrow();
    expect(() => normalizeIp('not-an-ip')).toThrow();
    expect(() => normalizeIp('300.1.1.1')).toThrow();
  });
});

describe('normalizeCidr / cidrContains', () => {
  it('normalizes host addresses to /32 and /128', () => {
    expect(normalizeCidr('10.0.0.5')).toEqual({ cidr: '10.0.0.5/32', family: 'ipv4' });
    expect(normalizeCidr('2001:db8::1')).toEqual({ cidr: '2001:db8::1/128', family: 'ipv6' });
  });

  it('masks network bits including non-byte boundaries', () => {
    expect(normalizeCidr('192.168.1.77/24')).toEqual({ cidr: '192.168.1.0/24', family: 'ipv4' });
    expect(normalizeCidr('10.1.2.3/20')).toEqual({ cidr: '10.1.0.0/20', family: 'ipv4' });
    expect(normalizeCidr('2001:db8::abcd/48')).toEqual({ cidr: '2001:db8::/48', family: 'ipv6' });
  });

  it('supports IPv4-mapped CIDRs and rejects bad prefixes', () => {
    expect(normalizeCidr('::ffff:192.0.2.1/120')).toEqual({ cidr: '192.0.2.0/24', family: 'ipv4' });
    expect(() => normalizeCidr('10.0.0.0/33')).toThrow();
    expect(() => normalizeCidr('10.0.0.0/abc')).toThrow();
    expect(() => normalizeCidr('2001:db8::/129')).toThrow();
  });

  it('checks containment across families', () => {
    expect(cidrContains('192.168.0.0/16', '192.168.44.9')).toBe(true);
    expect(cidrContains('192.168.0.0/16', '192.169.0.1')).toBe(false);
    expect(cidrContains('2001:db8::/32', '2001:db8:ffff::1')).toBe(true);
    expect(cidrContains('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(cidrContains('192.168.0.0/16', '2001:db8::1')).toBe(false);
    expect(cidrContains('0.0.0.0/0', '203.0.113.7')).toBe(true);
  });
});

describe('IpMatcher', () => {
  it('matches mixed IPv4 and IPv6 rules and reports size', () => {
    const matcher = new IpMatcher();
    matcher.add('10.0.0.0/8');
    matcher.add('192.168.1.0/24');
    matcher.add('2001:db8::/32');
    expect(matcher.size).toBe(3);
    expect(matcher.has('10.2.3.4')).toBe(true);
    expect(matcher.has('192.168.1.200')).toBe(true);
    expect(matcher.has('192.168.2.1')).toBe(false);
    expect(matcher.has('2001:db8::42')).toBe(true);
    expect(matcher.has('2001:db9::42')).toBe(false);
  });

  it('returns false rather than throwing for malformed input', () => {
    const matcher = new IpMatcher();
    matcher.add('127.0.0.1/32');
    expect(matcher.has('not-an-ip')).toBe(false);
  });
});

describe('trusted proxies and helper parsing', () => {
  it('only trusts explicitly listed proxy ranges', () => {
    expect(isTrustedProxy('127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(isTrustedProxy('::1', ['::1/128'])).toBe(true);
    expect(isTrustedProxy('10.0.0.5', ['127.0.0.1/32', '::1/128'])).toBe(false);
    expect(isTrustedProxy(undefined, ['127.0.0.1/32'])).toBe(false);
    expect(isTrustedProxy('127.0.0.1', ['broken'])).toBe(false);
  });

  it('parses comma-separated CIDR lists', () => {
    expect(parseCidrList(' 127.0.0.1/32, ::1/128 ,, 10.0.0.0/8 ')).toEqual([
      '127.0.0.1/32',
      '::1/128',
      '10.0.0.0/8'
    ]);
  });
});

describe('isPrivateOrReservedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '203.0.113.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1'
  ])('treats %s as private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  );

  it('fails closed for malformed input', () => {
    expect(isPrivateOrReservedIp('garbage')).toBe(true);
  });
});
