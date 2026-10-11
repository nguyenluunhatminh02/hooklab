import {
  DESTINATION_AUTH_TYPES,
  DESTINATION_AUTH_VALUE_FORBIDDEN_PATTERN,
  DESTINATION_HEADER_NAME_MAX_LENGTH,
  DESTINATION_HEADER_NAME_PATTERN,
  DESTINATION_HEADER_OWS_PATTERN,
  DESTINATION_HEADER_VALUE_MAX_LENGTH,
} from './subscribers.constants';

/**
 * Outbound destination auth, stored as a single nullable JSON column
 * (02 §4 destinationAuth):
 *
 *   null                     → no credential (no header is added)
 *   { type: 'bearer',  token }              → Authorization: Bearer <token>
 *   { type: 'basic',   username, password } → Authorization: Basic base64(user:pass)
 *   { type: 'apiKey',  headerName, value }  → <headerName>: <value>
 *   { type: 'none' }                        → wire-only "clear" marker, never persisted
 *
 * `type` is never persisted as 'none': the DTO defaults to it and the service
 * maps it to column NULL, so the column is either absent or holds a real
 * credential. Secrets stay plaintext in the column — the server must render
 * them into outbound headers at replay time — so every serialization boundary
 * reduces them to a hint (mirror of hmacSecret, 02 §4).
 */
export type DestinationAuthType = (typeof DESTINATION_AUTH_TYPES)[number];

export type DestinationAuthStored =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; headerName: string; value: string };

export type DestinationAuthWire =
  | { type: 'none' }
  | { type: 'bearer'; token?: string }
  | { type: 'basic'; username?: string; password?: string }
  | { type: 'apiKey'; headerName?: string; value?: string };

export type DestinationAuthMasked =
  | { type: 'none' }
  | { type: 'bearer'; tokenHint: string }
  | { type: 'basic'; usernameHint: string }
  | { type: 'apiKey'; headerName: string; valueHint: string };

/** The single outbound header a stored credential becomes, or null. */
export type DestinationAuthHeader = { headerName: string; headerValue: string } | null;

/** 02 §4 authHint — '…abcd', same shape as SecretService.hint. */
export const authHint = (secret: string): string => `…${secret.slice(-4)}`;

/** What replaces credential material found in a stored destination response body. */
export const AUTH_REDACTED_MARKER = '[redacted]';

/**
 * Wire → stored: the only place 'none' disappears. Every stored credential is
 * built exclusively from fields the DTO constraint has already vetted, so it
 * is replay-safe by construction (conventions §3). The typeof guards exist
 * because wire fields are optional on the type; validation guarantees they are
 * present, and a malformed record degrades to no-credential rather than a
 * thrown cast.
 */
export function parseDestinationAuth(wire: DestinationAuthWire): DestinationAuthStored | null {
  // @IsOptional lets an explicit JSON null through untouched, so a null can
  // reach this function from the wire. Degrade like any malformed record: the
  // call site decides what a null means ("no credential" on create, "keep the
  // stored credential" on PATCH) — never a thrown cast.
  if (typeof wire !== 'object' || wire === null) {
    return null;
  }
  switch (wire.type) {
    case 'bearer':
      return typeof wire.token === 'string' ? { type: 'bearer', token: wire.token } : null;
    case 'basic':
      return typeof wire.username === 'string' && typeof wire.password === 'string'
        ? { type: 'basic', username: wire.username, password: wire.password }
        : null;
    case 'apiKey':
      return typeof wire.headerName === 'string' && typeof wire.value === 'string'
        ? { type: 'apiKey', headerName: wire.headerName, value: wire.value }
        : null;
    default:
      return null;
  }
}

/**
 * Serialize the stored credential: the last 4 chars of each secret, never
 * more — the same rule as hmacSecret's secretHint. Prisma reads an SQL-NULL
 * JSON column back as plain `null` (the DbNull sentinel is write-only), so
 * that single guard covers the empty case.
 */
export function maskDestinationAuth(stored: unknown): DestinationAuthMasked {
  const value = asCredentialRecord(stored);
  if (value === null) {
    return { type: 'none' };
  }
  switch (value.type) {
    case 'bearer':
      return typeof value.token === 'string'
        ? { type: 'bearer', tokenHint: authHint(value.token) }
        : { type: 'none' };
    case 'basic':
      return typeof value.username === 'string'
        ? { type: 'basic', usernameHint: authHint(value.username) }
        : { type: 'none' };
    case 'apiKey':
      return typeof value.headerName === 'string' && typeof value.value === 'string'
        ? { type: 'apiKey', headerName: value.headerName, valueHint: authHint(value.value) }
        : { type: 'none' };
    default:
      return { type: 'none' };
  }
}

/**
 * Compute the single outbound header a stored credential must become, or null
 * when the subscriber has none. The caller folds this header into the replay
 * request case-insensitively (replay.service.ts mergeHeaders), so the spelling
 * here ('authorization' for bearer/basic, the user's chosen token for apiKey)
 * cannot smuggle a second copy of the same field past a destinationHeaders
 * entry — RFC 7230 field names are case-insensitive, regardless of spelling.
 */
export function destinationAuthCredentials(stored: unknown): DestinationAuthHeader {
  const value = asCredentialRecord(stored);
  if (value === null) {
    return null;
  }
  switch (value.type) {
    case 'bearer':
      if (typeof value.token !== 'string') return null;
      return safeHeader('authorization', `Bearer ${value.token}`);
    case 'basic':
      if (typeof value.username !== 'string' || typeof value.password !== 'string') return null;
      return safeHeader(
        'authorization',
        `Basic ${Buffer.from(`${value.username}:${value.password}`).toString('base64')}`,
      );
    case 'apiKey':
      if (typeof value.headerName !== 'string' || typeof value.value !== 'string') return null;
      return safeHeader(value.headerName, value.value);
    default:
      return null;
  }
}

/**
 * The outbound-header contract shared with the DTO gate: the emitted value is
 * one visible line (C0/DEL or above-Latin-1 would split the header block or
 * make fetch throw — mislabeled as a transport error), non-empty, and bounded —
 * exactly what fetch will send. Callers pass the wire spelling; safeHeader
 * normalizes OWS first. The replay leg re-checks on every send as defense in
 * depth (a legacy row could predate the DTO gate).
 */
export function isReplaySafeAuthHeader(name: string, value: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= DESTINATION_HEADER_NAME_MAX_LENGTH &&
    DESTINATION_HEADER_NAME_PATTERN.test(name) &&
    !DESTINATION_AUTH_VALUE_FORBIDDEN_PATTERN.test(value) &&
    value.length > 0 &&
    value.length <= DESTINATION_HEADER_VALUE_MAX_LENGTH
  );
}

/**
 * The serialization-boundary rule for destination responses: a destination may
 * echo what we sent — httpbin-style, by design — and whatever comes back gets
 * stored as the replay leg's response body and rendered in record detail
 * (02 §5). A plaintext credential must not ride that route into a stored row
 * (02 §4 "never serialized"), so the emitted value is scrubbed on the way in.
 * Exact-match only: this redacts what this very request sent, nothing else.
 */
export function redactDestinationResponseBody(body: string, credential: DestinationAuthHeader): string {
  if (credential === null || credential.headerValue.length === 0) return body;
  return body.split(credential.headerValue).join(AUTH_REDACTED_MARKER);
}

function safeHeader(name: string, value: string): DestinationAuthHeader {
  // Normalize to the spelling fetch will actually put on the wire: WHATWG
  // trims leading/trailing SP/HTAB from every header value before sending, so
  // emitting the padded form would leave the redaction target (this object)
  // disagreeing with the value an echoing destination reflects back. Done
  // before the non-empty gate so an all-whitespace value degrades to null.
  const wireValue = value.replace(DESTINATION_HEADER_OWS_PATTERN, '');
  return isReplaySafeAuthHeader(name, wireValue) ? { headerName: name, headerValue: wireValue } : null;
}

/** Loose view of the JSON column; every consumer guards before use. */
function asCredentialRecord(stored: unknown): Record<string, unknown> | null {
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : null;
}