// Subscriber module contract values (design 02 §4). App-wide values
// (TOKEN_BYTES, MAX_DESTINATION_HEADERS) live in common/constants and are
// imported, never redefined.

export const SUBSCRIBER_NAME_MAX_LENGTH = 80;

/** IngestController is @Controller('ingest') + @Post(':token'). */
export const INGEST_PATH_PREFIX = '/ingest/';

/** 02 §4 DTO sketch — e.g. X-Hub-Signature-256. */
export const SIGNATURE_HEADER_PATTERN = /^[\w-]{1,64}$/;

/**
 * RFC 7230 token chars for destination header names. The charset has no CR/LF
 * (or any whitespace), so injection through the name is rejected structurally.
 */
export const DESTINATION_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const DESTINATION_HEADER_NAME_MAX_LENGTH = 128;

/** Bounded JSON column: one header value, not a request body. */
export const DESTINATION_HEADER_VALUE_MAX_LENGTH = 4096;

/**
 * Outbound destination auth (02 §4): credential *types* — `none` exists only
 * on the wire so a PATCH can explicitly clear a previously stored credential;
 * it is never persisted (column stays NULL).
 */
export const DESTINATION_AUTH_TYPES = ['none', 'bearer', 'basic', 'apiKey'] as const;
export type DestinationAuthType = (typeof DESTINATION_AUTH_TYPES)[number];

/**
 * C0 controls + DEL + everything above Latin-1: a credential must be one
 * visible line because it becomes an HTTP header value at replay — CR/LF would
 * split the header block, and any other rejected code unit makes fetch throw
 * (fetch converts header values to a ByteString) or the header block invalid,
 * which the transport catch would mislabel a transport error. C1 controls
 * (U+0080–U+009F) and U+00A0 pass through untouched and stay allowed. Interior
 * SP/HTAB survive the wire; only leading/trailing SP/HTAB are normalized, see
 * DESTINATION_HEADER_OWS_PATTERN.
 */
export const DESTINATION_AUTH_VALUE_FORBIDDEN_PATTERN = /[\u0000-\u001F\u007FĀ-￿]/;

/**
 * The whitespace WHATWG fetch strips from a header value before it reaches the
 * wire: leading/trailing SP and HTAB, nothing else. Normalizing the emitted
 * credential to this spelling keeps the sent header, the header object the
 * transport received, and the redaction target in agreement; a padded
 * credential would otherwise be sent trimmed while redaction looked for the
 * padded form — the echo would carry the plaintext past the scrub.
 */
export const DESTINATION_HEADER_OWS_PATTERN = /^[ \t]+|[ \t]+$/g;

/**
 * Passthrough destination-header values ride the same wire as credentials, so
 * they must survive the same ByteString conversion: C0 controls other than
 * HTAB (a legal interior tab) and anything above Latin-1 make fetch throw at
 * replay — a mislabeled transport error instead of a write-time 400.
 */
export const DESTINATION_HEADER_VALUE_FORBIDDEN_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007FĀ-￿]/;

/** 02 §4 wire notes — surfaced once per action in the reveal modal. */
export const ROTATE_NOTE = 'previous secret invalid immediately; rate-limit window reset';
export const REVOKE_NOTE = 'ingest now answers 410 Gone; future requests are not recorded';

export const SUBSCRIBER_NOT_FOUND_MESSAGE = 'subscriber not found';

/** 02 §4 secretHint renders "…cdef" — the last 4 chars, safe for list/detail. */
export const SECRET_HINT_LENGTH = 4;
export const SECRET_HINT_ELLIPSIS = '…';
