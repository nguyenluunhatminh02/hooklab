import {
  AUTH_REDACTED_MARKER,
  authHint,
  destinationAuthCredentials,
  isReplaySafeAuthHeader,
  maskDestinationAuth,
  parseDestinationAuth,
  redactDestinationResponseBody,
} from './destination-auth';
import { IsDestinationAuthConstraint } from './subscribers.constraints';
import {
  DESTINATION_HEADER_NAME_MAX_LENGTH,
  DESTINATION_HEADER_VALUE_MAX_LENGTH,
} from './subscribers.constants';

describe('destination-auth (02 §4 outbound credential contract)', () => {
  describe('parseDestinationAuth — wire → stored', () => {
    it('maps each type to its stored shape', () => {
      expect(parseDestinationAuth({ type: 'bearer', token: 'tok' })).toEqual({
        type: 'bearer',
        token: 'tok',
      });
      expect(parseDestinationAuth({ type: 'basic', username: 'u', password: 'p' })).toEqual({
        type: 'basic',
        username: 'u',
        password: 'p',
      });
      expect(parseDestinationAuth({ type: 'apiKey', headerName: 'X-Key', value: 'v' })).toEqual({
        type: 'apiKey',
        headerName: 'X-Key',
        value: 'v',
      });
    });

    it('drops the wire-only "none" marker to null and ignores malformed records', () => {
      expect(parseDestinationAuth({ type: 'none' })).toBeNull();
      expect(parseDestinationAuth({ type: 'bearer' })).toBeNull();
      expect(parseDestinationAuth({ type: 'apiKey', headerName: 'X-Key' })).toBeNull();
    });
  });

  describe('authHint — the only secret form that may serialize', () => {
    it('renders exactly the last 4 characters, prefixed', () => {
      expect(authHint('abcdef0123456789')).toBe('…6789');
      expect(authHint('abc')).toBe('…abc');
    });
  });

  describe('maskDestinationAuth', () => {
    it('serializes no credential as type none', () => {
      expect(maskDestinationAuth(null)).toEqual({ type: 'none' });
      expect(maskDestinationAuth(undefined)).toEqual({ type: 'none' });
    });

    it('reduces each stored credential to hints — the full secret never serializes', () => {
      expect(maskDestinationAuth({ type: 'bearer', token: 'tok-abcdef' })).toEqual({
        type: 'bearer',
        tokenHint: '…cdef',
      });
      expect(maskDestinationAuth({ type: 'basic', username: 'svc-1234', password: 'p' })).toEqual({
        type: 'basic',
        usernameHint: '…1234',
      });
      expect(maskDestinationAuth({ type: 'apiKey', headerName: 'X-Key', value: 'key-5678' })).toEqual({
        type: 'apiKey',
        headerName: 'X-Key',
        valueHint: '…5678',
      });
    });

    it('degrades malformed rows to none instead of crashing serialization', () => {
      expect(maskDestinationAuth('not an object')).toEqual({ type: 'none' });
      expect(maskDestinationAuth(42)).toEqual({ type: 'none' });
      expect(maskDestinationAuth({ type: 'bearer' })).toEqual({ type: 'none' });
    });
  });

  describe('destinationAuthCredentials — the exact outbound header', () => {
    it('returns null when there is no stored credential', () => {
      expect(destinationAuthCredentials(null)).toBeNull();
      expect(destinationAuthCredentials(undefined)).toBeNull();
    });

    it('renders Bearer for type bearer', () => {
      expect(destinationAuthCredentials({ type: 'bearer', token: 'token-abc' })).toEqual({
        headerName: 'authorization',
        headerValue: 'Bearer token-abc',
      });
    });

    it('renders Basic base64(user:pass) for type basic', () => {
      expect(
        destinationAuthCredentials({ type: 'basic', username: 'svc', password: 'p@ss' }),
      ).toEqual({
        headerName: 'authorization',
        headerValue: `Basic ${Buffer.from('svc:p@ss').toString('base64')}`,
      });
    });

    it('renders the user-chosen header for type apiKey', () => {
      expect(
        destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Api-Key', value: 'v-1' }),
      ).toEqual({ headerName: 'X-Api-Key', headerValue: 'v-1' });
    });

    it('normalizes the OWS fetch strips, so the returned value is the wire value', () => {
      // undici trims leading/trailing SP/HTAB before sending; a padded
      // credential must be emitted — and therefore redacted — in its trimmed
      // spelling. Interior whitespace survives the wire and is preserved.
      expect(destinationAuthCredentials({ type: 'bearer', token: 'tok-abc ' })).toEqual({
        headerName: 'authorization',
        headerValue: 'Bearer tok-abc',
      });
      expect(
        destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Key', value: '  v-1\t' }),
      ).toEqual({ headerName: 'X-Key', headerValue: 'v-1' });
      expect(
        destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Key', value: 'a b' }),
      ).toEqual({ headerName: 'X-Key', headerValue: 'a b' });
      // An all-whitespace value normalizes to empty — no credential, no header.
      expect(destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Key', value: '   ' })).toBeNull();
      // NBSP is not OWS: undici sends it untouched, so it must survive here.
      expect(
        destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Key', value: ' v ' }),
      ).toEqual({ headerName: 'X-Key', headerValue: ' v ' });
    });

    it('degrades unsafe rows to null (defense in depth for legacy data)', () => {
      // CR/LF in a credential would split the outbound header block at replay.
      expect(destinationAuthCredentials({ type: 'bearer', token: 'a\r\nX-Evil: 1' })).toBeNull();
      expect(destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Key', value: 'a\rb' })).toBeNull();
      // Above Latin-1 (and lone surrogates) make fetch throw a ByteString
      // conversion, which the transport catch would mislabel a 502.
      expect(destinationAuthCredentials({ type: 'bearer', token: 'tok-日本語' })).toBeNull();
      expect(destinationAuthCredentials({ type: 'apiKey', headerName: 'X-Key', value: 'a\uD800b' })).toBeNull();
      expect(destinationAuthCredentials({ type: 'bearer' })).toBeNull();
      expect(destinationAuthCredentials('garbage')).toBeNull();
    });
  });

  describe('isReplaySafeAuthHeader — the header contract shared with the DTO gate', () => {
    it('accepts a single-line non-empty bounded pair', () => {
      expect(isReplaySafeAuthHeader('authorization', 'Bearer abc')).toBe(true);
      expect(isReplaySafeAuthHeader('X-Key', 'x'.repeat(DESTINATION_HEADER_VALUE_MAX_LENGTH))).toBe(true);
    });

    it('rejects header-splitting and absurd rows', () => {
      expect(isReplaySafeAuthHeader('authorization', 'a\r\nX-Injected: 1')).toBe(false);
      expect(isReplaySafeAuthHeader('authorization', 'a\u0000b')).toBe(false);
      expect(isReplaySafeAuthHeader('X-Key', '')).toBe(false);
      expect(isReplaySafeAuthHeader('', 'v')).toBe(false);
      expect(isReplaySafeAuthHeader('X-Key', 'v'.repeat(DESTINATION_HEADER_VALUE_MAX_LENGTH + 1))).toBe(false);
    });

    it('rejects anything above Latin-1 — fetch cannot convert it to a ByteString', () => {
      expect(isReplaySafeAuthHeader('authorization', 'Bearer tok-日本語')).toBe(false);
      expect(isReplaySafeAuthHeader('X-Key', 'a\uD800b')).toBe(false);
      // The boundary: U+00FF is the last code unit fetch carries.
      expect(isReplaySafeAuthHeader('authorization', 'Bearer café')).toBe(true);
    });
  });

  describe('redactDestinationResponseBody — echo scrub at the storage boundary', () => {
    const bearer = { headerName: 'authorization', headerValue: 'Bearer tok-secret' };

    it('replaces every occurrence of the emitted value', () => {
      const body = JSON.stringify({ sent: 'Bearer tok-secret', again: 'Bearer tok-secret' });
      const scrubbed = redactDestinationResponseBody(body, bearer);
      expect(scrubbed).not.toContain('tok-secret');
      expect(scrubbed.split(AUTH_REDACTED_MARKER)).toHaveLength(3);
    });

    it('leaves the body untouched without a credential, or when nothing was echoed', () => {
      expect(redactDestinationResponseBody('{"ok":true}', null)).toBe('{"ok":true}');
      expect(redactDestinationResponseBody('{"ok":true}', bearer)).toBe('{"ok":true}');
    });

    it('does not touch partial material — exact emitted value only', () => {
      // The bare token without the scheme is not what this leg sent.
      expect(redactDestinationResponseBody('tok-secret', bearer)).toBe('tok-secret');
    });
  });

  describe('IsDestinationAuthConstraint — the DTO gate over the whole record', () => {
    const constraint = new IsDestinationAuthConstraint();

    it('accepts each sanctioned shape', () => {
      expect(constraint.validate({ type: 'none' })).toBe(true);
      expect(constraint.validate({ type: 'bearer', token: 't' })).toBe(true);
      expect(constraint.validate({ type: 'basic', username: 'u', password: 'p' })).toBe(true);
      expect(constraint.validate({ type: 'apiKey', headerName: 'X-Key', value: 'v' })).toBe(true);
    });

    it('rejects non-objects, unknown types, and extra keys under none', () => {
      expect(constraint.validate(null)).toBe(false);
      expect(constraint.validate('bearer')).toBe(false);
      expect(constraint.validate([])).toBe(false);
      expect(constraint.validate({ type: 'digest' })).toBe(false);
      expect(constraint.validate({ type: 'none', token: 'sneaky' })).toBe(false);
    });

    it('rejects missing, extra, or non-credential fields per type', () => {
      expect(constraint.validate({ type: 'bearer' })).toBe(false);
      expect(constraint.validate({ type: 'bearer', token: 't', extra: 'x' })).toBe(false);
      expect(constraint.validate({ type: 'basic', username: 'u' })).toBe(false);
      expect(constraint.validate({ type: 'apiKey', headerName: 'X-Key' })).toBe(false);
      expect(constraint.validate({ type: 'bearer', token: 42 })).toBe(false);
    });

    it('enforces the apiKey header-name token and bounded values', () => {
      expect(constraint.validate({ type: 'apiKey', headerName: 'X-Bad Name!', value: 'v' })).toBe(false);
      expect(
        constraint.validate({
          type: 'apiKey',
          headerName: 'X'.repeat(DESTINATION_HEADER_NAME_MAX_LENGTH + 1),
          value: 'v',
        }),
      ).toBe(false);
      expect(constraint.validate({ type: 'bearer', token: '' })).toBe(false);
      expect(
        constraint.validate({ type: 'bearer', token: 'x'.repeat(DESTINATION_HEADER_VALUE_MAX_LENGTH + 1) }),
      ).toBe(false);
      expect(constraint.validate({ type: 'bearer', token: 'a\r\nb' })).toBe(false);
      expect(constraint.validate({ type: 'bearer', token: 'a\u0000b' })).toBe(false);
    });

    it('rejects credentials fetch cannot carry, accepts the Latin-1 boundary', () => {
      // The ByteString conversion throws for these at replay time, which the
      // transport catch would mislabel a 502 — the gate must 400 up front.
      expect(constraint.validate({ type: 'bearer', token: 'tok-日本語' })).toBe(false);
      expect(constraint.validate({ type: 'apiKey', headerName: 'X-Key', value: 'a\uD800b' })).toBe(false);
      expect(constraint.validate({ type: 'bearer', token: 'café' })).toBe(true);
    });
  });
});