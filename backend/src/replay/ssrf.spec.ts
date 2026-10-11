jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'dns/promises';
import { isBlockedAddress, resolveDestination } from './ssrf';

const lookupMock = lookup as unknown as jest.Mock;

// BUILD_PLAN §8.2 rows plus the audit additions (fe80::/10, ::, 100.64.0.0/10)
// and explicit boundary neighbours on both sides of every CIDR edge.
const BLOCKED_ADDRESSES = [
  '127.0.0.1',
  '127.255.255.255',
  '10.0.0.1',
  '10.255.255.255',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '192.168.255.255',
  '169.254.169.254',
  '169.254.0.1',
  '0.0.0.0',
  '0.1.2.3',
  '100.64.0.1',
  '100.127.255.255',
  '::1',
  '::',
  'fc00::1',
  'fd12:3456::1',
  'fdff:ffff::1',
  'fe80::1',
  'fe80::a00:27ff:fe4e:66a1',
  'febf::1',
  '::ffff:127.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:10.0.0.1',
  '::ffff:0.0.0.0',
];

const ALLOWED_ADDRESSES = [
  '8.8.8.8',
  '93.184.216.34',
  '1.1.1.1',
  '11.0.0.0',
  '1.0.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.169.0.1',
  '169.253.255.255',
  '169.255.0.1',
  '2606:4700::1111',
  '2001:4860:4860::8888',
  '2400:cb00:2048:1::c629:d7a2',
  '::ffff:8.8.8.8',
  'fec0::1',
];

describe('ssrf.isBlockedAddress', () => {
  it.each(BLOCKED_ADDRESSES)('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(ALLOWED_ADDRESSES)('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('blocks unparsable input (fail closed)', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('ssrf.resolveDestination', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('checks an IPv4 literal host without touching DNS', async () => {
    const verdict = await resolveDestination(new URL('http://127.0.0.1/hook'));
    expect(verdict).toEqual({ blocked: true, blockedIp: '127.0.0.1' });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows a public IPv4 literal without touching DNS', async () => {
    const verdict = await resolveDestination(new URL('https://93.184.216.34/hook'));
    expect(verdict).toEqual({ blocked: false, blockedIp: null });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('strips IPv6 brackets before checking the literal', async () => {
    const publicV6 = await resolveDestination(new URL('http://[2606:4700::1111]/hook'));
    expect(publicV6).toEqual({ blocked: false, blockedIp: null });

    const loopbackV6 = await resolveDestination(new URL('http://[::1]/hook'));
    expect(loopbackV6).toEqual({ blocked: true, blockedIp: '::1' });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks when ANY A/AAAA answer is private (rebinding-style mixed records)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const verdict = await resolveDestination(new URL('https://mixed.example/hook'));
    expect(verdict).toEqual({ blocked: true, blockedIp: '127.0.0.1' });
    expect(lookupMock).toHaveBeenCalledWith('mixed.example', { all: true });
  });

  it('allows a fully public answer set', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const verdict = await resolveDestination(new URL('https://public.example/hook'));
    expect(verdict).toEqual({ blocked: false, blockedIp: null });
  });

  it('fails closed on DNS errors (NXDOMAIN, timeouts)', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const verdict = await resolveDestination(new URL('https://nxdomain.example/hook'));
    expect(verdict).toEqual({ blocked: true, blockedIp: null });
    expect(lookupMock).toHaveBeenCalledWith('nxdomain.example', { all: true });
  });

  it('fails closed on an empty answer set', async () => {
    lookupMock.mockResolvedValue([]);
    const verdict = await resolveDestination(new URL('https://empty.example/hook'));
    expect(verdict).toEqual({ blocked: true, blockedIp: null });
  });

  it('blocks a private AAAA answer', async () => {
    lookupMock.mockResolvedValue([
      { address: '2606:4700::1111', family: 6 },
      { address: 'fc00::1', family: 6 },
    ]);
    const verdict = await resolveDestination(new URL('https://v6mixed.example/hook'));
    expect(verdict).toEqual({ blocked: true, blockedIp: 'fc00::1' });
  });
});
