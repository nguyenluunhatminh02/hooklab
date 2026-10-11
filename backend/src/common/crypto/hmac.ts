import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_PREFIX } from '../constants/ingest.constants';

const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

export type VerifySignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'invalid_signature' };

/**
 * HMAC-SHA256 verification for ingest (design 03 §9, BUILD_PLAN §4.2 step 4).
 * Pure and total: never throws, so a hostile header can never turn into a 500.
 * Length and charset are checked BEFORE timingSafeEqual — that function throws
 * on unequal buffer lengths, and a throw here would leak into the request path
 * instead of producing `invalid_signature`.
 */
export function verifySignature(
  rawBody: Buffer,
  headerValue: string | string[] | undefined,
  secret: string,
): VerifySignatureResult {
  if (Array.isArray(headerValue)) {
    // Node only yields an array for a repeated header; two signatures for one
    // body are ambiguous, so fail closed instead of picking one.
    if (headerValue.length !== 1) {
      return { ok: false, reason: 'invalid_signature' };
    }
    return verifyDigest(rawBody, headerValue[0], secret);
  }
  if (headerValue === undefined) {
    return { ok: false, reason: 'missing_signature' };
  }
  return verifyDigest(rawBody, headerValue, secret);
}

function verifyDigest(
  rawBody: Buffer,
  presented: string,
  secret: string,
): VerifySignatureResult {
  if (!presented.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const hex = presented.slice(SIGNATURE_PREFIX.length);
  if (hex.length !== SHA256_HEX_LENGTH || !HEX_PATTERN.test(hex)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(hex, 'hex');
  return timingSafeEqual(expected, received)
    ? { ok: true }
    : { ok: false, reason: 'invalid_signature' };
}
