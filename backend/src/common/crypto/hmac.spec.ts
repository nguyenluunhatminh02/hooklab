import { createHmac } from 'node:crypto';
import { SIGNATURE_PREFIX } from '../constants/ingest.constants';
import { verifySignature } from './hmac';

const SECRET = 'test-hmac-secret';
const BODY = Buffer.from('what do ya want for nothing?');

function sign(body: Buffer, secret: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  // RFC 4231 case 2 — the canonical HMAC-SHA256 vector every implementation
  // must reproduce; if this fails nothing else here is meaningful.
  it('matches the RFC 4231 case-2 test vector', () => {
    const header = SIGNATURE_PREFIX + '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    expect(verifySignature(BODY, header, 'Jefe')).toEqual({ ok: true });
  });

  it('accepts a correct digest over the exact raw bytes', () => {
    const body = Buffer.from('{"type":"order.created","id":42}', 'utf8');
    expect(verifySignature(body, sign(body, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('is byte-sensitive: a one-byte body change invalidates the signature', () => {
    const body = Buffer.from('{"a":1}');
    const tampered = Buffer.from('{"a":2}');
    expect(verifySignature(tampered, sign(body, SECRET), SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('is key-order sensitive: JSON key order is part of the signed bytes', () => {
    const signed = Buffer.from('{"a":1,"b":2}');
    const reordered = Buffer.from('{"b":2,"a":1}');
    expect(verifySignature(reordered, sign(signed, SECRET), SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('returns missing_signature when the header is absent', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it.each([
    ['empty header', ''],
    ['no sha256= prefix', 'abcdef'.padEnd(64, '0')],
    ['wrong algorithm prefix', `sha1=${'0'.repeat(64)}`],
  ])('returns invalid_signature for %s', (_label, header) => {
    expect(verifySignature(BODY, header, SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  // length-check BEFORE timingSafeEqual: a 63-char hex must not throw.
  it.each([
    ['63-char hex', '0'.repeat(63)],
    ['65-char hex', '0'.repeat(65)],
    ['32-char hex (sha1 length)', '0'.repeat(32)],
    ['non-hex characters', `${'g'.repeat(64)}`],
    ['hex with whitespace', `${'0'.repeat(63)} `],
  ])('returns invalid_signature without throwing for %s', (_label, hex) => {
    const header = SIGNATURE_PREFIX + hex;
    expect(() => verifySignature(BODY, header, SECRET)).not.toThrow();
    expect(verifySignature(BODY, header, SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects a digest with one flipped nibble', () => {
    const good = sign(BODY, SECRET);
    const last = good.at(-1);
    expect(last).toBeDefined();
    const flipped = last === '3' ? '2' : '3';
    const header = good.slice(0, -1) + flipped;
    expect(verifySignature(BODY, header, SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('accepts a single-element array header (Node folds repeated headers)', () => {
    expect(verifySignature(BODY, [sign(BODY, SECRET)], SECRET)).toEqual({ ok: true });
  });

  it('rejects a multi-element array header as ambiguous', () => {
    const good = sign(BODY, SECRET);
    expect(verifySignature(BODY, [good, good], SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifySignature(BODY, sign(BODY, 'other-secret'), SECRET)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('handles an empty body', () => {
    const empty = Buffer.alloc(0);
    expect(verifySignature(empty, sign(empty, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('handles non-UTF8 binary bytes without mangling them', () => {
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x7f, 0xc0]);
    expect(verifySignature(binary, sign(binary, SECRET), SECRET)).toEqual({ ok: true });
  });
});
