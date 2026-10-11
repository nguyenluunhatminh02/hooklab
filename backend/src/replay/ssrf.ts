import { lookup } from 'dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

export interface SsrfVerdict {
  blocked: boolean;
  /** Address that tripped the blocklist; null when DNS itself failed. */
  blockedIp: string | null;
}

interface Ipv4Range {
  base: number;
  prefixBits: number;
}

interface Ipv6Range {
  base: Uint8Array;
  prefixBits: number;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function ipv4Range(base: string, prefixBits: number): Ipv4Range {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) throw new Error(`SSRF blocklist has a non-IPv4 base: ${base}`);
  return { base: baseInt, prefixBits };
}

function ipv6ToBytes(address: string): Uint8Array | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null;
  const leftPart = doubleColon === -1 ? text : text.slice(0, doubleColon);
  const rightPart = doubleColon === -1 ? '' : text.slice(doubleColon + 2);
  const left = leftPart === '' ? [] : leftPart.split(':');
  const right = rightPart === '' ? [] : rightPart.split(':');
  const tokens = [...left, ...right];
  const groups: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes('.')) {
      if (index !== tokens.length - 1) return null;
      const v4 = ipv4ToInt(token);
      if (v4 === null) return null;
      groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  if (doubleColon !== -1) {
    // '::' expands in place: left groups stay at the front, right groups at the
    // back, and the zero run fills the middle up to exactly 8 groups.
    if (groups.length > 7) return null;
    const zeros = new Array<number>(8 - groups.length).fill(0);
    groups.splice(left.length, 0, ...zeros);
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function ipv6Range(base: string, prefixBits: number): Ipv6Range {
  const baseBytes = ipv6ToBytes(base);
  if (baseBytes === null) throw new Error(`SSRF blocklist has a non-IPv6 base: ${base}`);
  return { base: baseBytes, prefixBits };
}

const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = [
  ipv4Range('0.0.0.0', 8),
  ipv4Range('10.0.0.0', 8),
  ipv4Range('100.64.0.0', 10),
  ipv4Range('127.0.0.0', 8),
  ipv4Range('169.254.0.0', 16),
  ipv4Range('172.16.0.0', 12),
  ipv4Range('192.168.0.0', 16),
];

const BLOCKED_IPV6_RANGES: readonly Ipv6Range[] = [
  ipv6Range('::', 128),
  ipv6Range('::1', 128),
  ipv6Range('fc00::', 7),
  ipv6Range('fe80::', 10),
];

function ipv4Mask(prefixBits: number): number {
  return prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
}

function blockedIpv4(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some((range) => (value & ipv4Mask(range.prefixBits)) === (range.base & ipv4Mask(range.prefixBits)));
}

function ipv6Matches(bytes: Uint8Array, range: Ipv6Range): boolean {
  const fullBytes = Math.floor(range.prefixBits / 8);
  for (let index = 0; index < fullBytes; index++) {
    if (bytes[index] !== range.base[index]) return false;
  }
  const remainder = range.prefixBits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes] & mask) === (range.base[fullBytes] & mask);
}

/** Non-null only for ::ffff:a.b.c.d mapped addresses (RFC 4291 v4-mapped). */
function ipv4FromMapped(bytes: Uint8Array): number | null {
  for (let index = 0; index < 10; index++) {
    if (bytes[index] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
}

export function isBlockedAddress(address: string): boolean {
  const candidate = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (isIPv4(candidate)) {
    const value = ipv4ToInt(candidate);
    return value === null ? true : blockedIpv4(value);
  }
  if (isIPv6(candidate)) {
    const bytes = ipv6ToBytes(candidate);
    if (bytes === null) return true;
    const mapped = ipv4FromMapped(bytes);
    if (mapped !== null) return blockedIpv4(mapped);
    return BLOCKED_IPV6_RANGES.some((range) => ipv6Matches(bytes, range));
  }
  // Callers only pass resolved addresses or IP literals; anything else is
  // unverifiable, so treat it as hostile rather than letting fetch decide.
  return true;
}

export async function resolveDestination(destination: URL): Promise<SsrfVerdict> {
  const hostname = destination.hostname.startsWith('[') ? destination.hostname.slice(1, -1) : destination.hostname;
  if (isIPv4(hostname) || isIPv6(hostname)) {
    // IP literals skip DNS (getaddrinfo would just echo them) but face the same
    // check — an attacker can put 169.254.169.254 straight into destinationUrl.
    return isBlockedAddress(hostname) ? { blocked: true, blockedIp: hostname } : { blocked: false, blockedIp: null };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    // NXDOMAIN/timeout ⇒ blocked (fail closed): an unresolvable attacker host
    // must never reach fetch, where a later DNS answer could rebind.
    return { blocked: true, blockedIp: null };
  }
  if (addresses.length === 0) return { blocked: true, blockedIp: null };
  // DNS-rebinding defence: EVERY A/AAAA answer must be public — mixed records
  // (one public, one private) are a classic rebinding probe.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) return { blocked: true, blockedIp: address };
  }
  return { blocked: false, blockedIp: null };
}
