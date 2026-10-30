import { BlockList, isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export type IpFamily = 'ipv4' | 'ipv6';

export interface NormalizedIp {
  ip: string;
  family: IpFamily;
}

/** Parses, unwraps IPv4-mapped IPv6 and canonicalizes an IP address. */
export function normalizeIp(input: string): NormalizedIp {
  let value = (input || '').trim();
  if (!value) throw new Error('Empty IP address');
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!isIP(value)) throw new Error(`Invalid IP address: ${input}`);
  const parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      const v4 = v6.toIPv4Address();
      return { ip: v4.toNormalizedString(), family: 'ipv4' };
    }
    return { ip: v6.toString(), family: 'ipv6' };
  }
  return { ip: (parsed as ipaddr.IPv4).toNormalizedString(), family: 'ipv4' };
}

function maskAddress(addr: ipaddr.IPv4 | ipaddr.IPv6, prefix: number): ipaddr.IPv4 | ipaddr.IPv6 {
  const bytes = addr.toByteArray();
  const totalBits = addr.kind() === 'ipv4' ? 32 : 128;
  for (let i = 0; i < bytes.length; i++) {
    const bitStart = i * 8;
    if (bitStart >= prefix) {
      bytes[i] = 0;
    } else if (bitStart + 8 > prefix) {
      const keep = prefix - bitStart;
      bytes[i] = (bytes[i] & (0xff << (8 - keep))) & 0xff;
    }
  }
  const parsed = ipaddr.fromByteArray(bytes);
  return parsed as ipaddr.IPv4 | ipaddr.IPv6;
}

/** Validates and canonicalizes an address or CIDR (single addresses become /32 or /128). */
export function normalizeCidr(input: string): { cidr: string; family: IpFamily } {
  const value = (input || '').trim();
  if (!value) throw new Error('Empty CIDR');
  let addrPart = value;
  let prefix: number | null = null;
  if (value.includes('/')) {
    const idx = value.lastIndexOf('/');
    addrPart = value.slice(0, idx);
    const prefixRaw = value.slice(idx + 1);
    if (!/^\d{1,3}$/.test(prefixRaw)) throw new Error('Invalid CIDR prefix');
    prefix = Number(prefixRaw);
  }
  const normalized = normalizeIp(addrPart);
  // Re-parse canonical text to avoid IPv4-mapped quirks.
  const canonical = ipaddr.parse(normalized.ip);
  const raw = ipaddr.parse(addrPart.replace(/^\[|\]$/g, ''));
  const mapped = raw.kind() === 'ipv6' && (raw as ipaddr.IPv6).isIPv4MappedAddress();
  let finalPrefix: number;
  if (prefix === null) {
    finalPrefix = normalized.family === 'ipv4' ? 32 : 128;
  } else if (mapped) {
    // IPv4-mapped rules use IPv6 prefix lengths; translate them to IPv4.
    if (prefix < 96) throw new Error('IPv4-mapped CIDR prefix must be at least 96');
    finalPrefix = prefix - 96;
  } else {
    finalPrefix = prefix;
  }
  const max = normalized.family === 'ipv4' ? 32 : 128;
  if (finalPrefix < 0 || finalPrefix > max) throw new Error(`CIDR prefix must be 0-${max}`);
  const network = maskAddress(canonical as ipaddr.IPv4 | ipaddr.IPv6, finalPrefix);
  const networkText =
    network.kind() === 'ipv6'
      ? (network as ipaddr.IPv6).toString()
      : (network as ipaddr.IPv4).toNormalizedString();
  const text = `${networkText}/${finalPrefix}`;
  // Ensure it round-trips.
  normalizeIp(text.split('/')[0]);
  return { cidr: text, family: normalized.family };
}

export function cidrContains(cidr: string, ip: string): boolean {
  const rule = normalizeCidr(cidr);
  const target = normalizeIp(ip);
  if (rule.family !== target.family) return false;
  const [network, prefix] = rule.cidr.split('/');
  const n = ipaddr.parse(network);
  const t = ipaddr.parse(target.ip);
  return (n as ipaddr.IPv4 | ipaddr.IPv6).match(t as ipaddr.IPv4 | ipaddr.IPv6, Number(prefix));
}

export class IpMatcher {
  private v4 = new BlockList();
  private v6 = new BlockList();
  private count = 0;

  add(cidr: string): void {
    const { cidr: canonical, family } = normalizeCidr(cidr);
    const [addr, prefixRaw] = canonical.split('/');
    const prefix = Number(prefixRaw);
    if (family === 'ipv4') this.v4.addSubnet(addr, prefix, 'ipv4');
    else this.v6.addSubnet(addr, prefix, 'ipv6');
    this.count++;
  }

  has(ip: string): boolean {
    try {
      const target = normalizeIp(ip);
      return target.family === 'ipv4'
        ? this.v4.check(target.ip, 'ipv4')
        : this.v6.check(target.ip, 'ipv6');
    } catch {
      return false;
    }
  }

  get size(): number {
    return this.count;
  }
}

export function isTrustedProxy(peerIp: string | undefined, trustedCidrs: string[]): boolean {
  if (!peerIp) return false;
  for (const cidr of trustedCidrs) {
    try {
      if (cidrContains(cidr, peerIp)) return true;
    } catch {
      // Ignore malformed configuration entries; env validation is reported elsewhere.
    }
  }
  return false;
}

export function parseCidrList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const PRIVATE_V4 = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'carrierGradeNat',
  'reserved',
  'benchmarking',
  'as112'
]);

/** True for loopback/private/link-local/reserved addresses (SSRF protection). */
export function isPrivateOrReservedIp(ip: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(normalizeIp(ip).ip);
  } catch {
    return true;
  }
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  const range = parsed.range();
  if (parsed.kind() === 'ipv4') return PRIVATE_V4.has(range) || range !== 'unicast';
  return (
    range === 'loopback' ||
    range === 'linkLocal' ||
    range === 'uniqueLocal' ||
    range === 'unspecified' ||
    range === 'multicast' ||
    range === 'reserved' ||
    range === 'ipv4Mapped' ||
    range === 'rfc6145' ||
    range === 'rfc6052' ||
    range === '6to4' ||
    range === 'teredo'
  );
}
