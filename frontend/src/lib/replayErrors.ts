/**
 * The single mapping point from a replay transport outcome to what the UI
 * renders (design 04 §6 table against the 02 §6 status contract). Pure and
 * dependency-light so one spec can walk the whole table.
 */
import { ApiError, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from '../api/httpClient';
import { REPLAY_TIMEOUT_MS, RETENTION_DAYS_FALLBACK } from '../config';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_GONE = 410;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
/** `ApiError.status === 0`: fetch threw, the request never reached the API. */
const HTTP_NO_RESPONSE = 0;

const SSRF_BLOCKED_CODE = 'replay_target_blocked';
const NETWORK_ERROR_CODE = 'network_error';

export type ReplayErrorKind =
  | 'blocked'
  | 'timeout'
  | 'upstream'
  | 'missing'
  | 'revoked'
  | 'unauthorized'
  | 'network'
  | 'tooLarge'
  | 'unexpected';

export interface ReplayErrorView {
  kind: ReplayErrorKind;
  title: string;
  hint: string;
  /** Retrying the identical request can succeed; blocked/revoked need a config change first. */
  retryable: boolean;
  /** 404: drop `?record=` so a record eaten by retention stops being refetched. */
  clearSelection: boolean;
  /** 410: keep the editor mounted but disabled — `hint` is the visible reason banner. */
  disableEditor: boolean;
  /**
   * 504 (02 §412): `details.replayRecordId` — the saved attempt row, so the
   * banner can open it. Absent on every other failure (and on a 504 answer
   * that somehow omits details).
   */
  replayRecordId?: number;
}

/**
 * Returns `null` only for the 200 success envelope: the destination answered
 * (any upstream status), so the caller renders `ReplayComparison` instead of
 * a banner. A destination's own 401/404 never arrive here — they travel inside
 * that envelope as `response.status` and are data, not API errors (02 §6).
 */
export function mapReplayError(
  status: number,
  code?: string,
  message?: string,
  /** Server-reported window (`stats.retention.days`); the constant only covers a missing stats call. */
  retentionDays: number = RETENTION_DAYS_FALLBACK,
): ReplayErrorView | null {
  if (status === HTTP_OK) return null;

  if (status === HTTP_NO_RESPONSE) {
    return {
      kind: 'network',
      title: 'Could not reach HookLab',
      hint: message ?? 'The request never reached the server — check your connection and retry.',
      retryable: true,
      clearSelection: false,
      disableEditor: false,
    };
  }

  if (status === HTTP_UNAUTHORIZED) {
    return {
      kind: 'unauthorized',
      title: 'Session expired',
      hint: 'Sign in again — you will come back to this record.',
      retryable: false,
      clearSelection: false,
      disableEditor: false,
    };
  }

  if (status === HTTP_NOT_FOUND) {
    return {
      kind: 'missing',
      title: 'Record not found',
      hint: `It left the ${retentionDays}-day retention window — refresh the timeline.`,
      retryable: false,
      clearSelection: true,
      disableEditor: false,
    };
  }

  if (status === HTTP_GONE) {
    return {
      kind: 'revoked',
      title: 'Subscriber revoked',
      hint: 'Replay is disabled: a revoked subscriber has no live destination.',
      retryable: false,
      clearSelection: false,
      disableEditor: true,
    };
  }

  if (status === HTTP_BAD_REQUEST && code === SSRF_BLOCKED_CODE) {
    return {
      kind: 'blocked',
      title: 'Target blocked',
      hint: 'The destination resolves to a private or metadata address — edit the destination URL to a public host.',
      retryable: false,
      clearSelection: false,
      disableEditor: false,
    };
  }

  if (status === HTTP_BAD_GATEWAY) {
    return {
      kind: 'upstream',
      title: 'Destination unreachable',
      hint: 'The connection failed (refused, TLS or DNS) — the attempt was saved; retry once the destination is up.',
      retryable: true,
      clearSelection: false,
      disableEditor: false,
    };
  }

  if (status === HTTP_GATEWAY_TIMEOUT) {
    return {
      kind: 'timeout',
      title: 'Destination timed out',
      hint: `No response within ${REPLAY_TIMEOUT_MS / 1000} s — the attempt was saved; retry once the destination is up.`,
      retryable: true,
      clearSelection: false,
      disableEditor: false,
    };
  }

  // 413 body_too_large: the replay route parses with the same 1 MiB cap as
  // ingest (main.ts), so an oversized edited body is rejected before the
  // handler runs — verified live against the running API, and documented as
  // its own 02 §6 failure row (parser rejection, no record written).
  if (status === HTTP_PAYLOAD_TOO_LARGE) {
    return {
      kind: 'tooLarge',
      title: 'Replay body too large',
      hint: 'The edited body exceeds the 1 MB replay cap — shorten it and replay again.',
      retryable: false,
      clearSelection: false,
      disableEditor: false,
    };
  }

  return {
    kind: 'unexpected',
    title: `Replay failed (${status})`,
    hint: message ?? 'The API answered outside the replay contract (02 §6).',
    retryable: false,
    clearSelection: false,
    disableEditor: false,
  };
}

/**
 * Turns a rejected `useReplay` mutation into a view. Non-`ApiError` causes
 * (a thrown hook, a cancelled fetch) are treated as transport failures — the
 * user never saw a server answer either way.
 */
export function replayErrorFromCause(
  cause: unknown,
  retentionDays: number = RETENTION_DAYS_FALLBACK,
): ReplayErrorView {
  const status = cause instanceof ApiError ? cause.status : HTTP_NO_RESPONSE;
  const code = cause instanceof ApiError ? cause.code : NETWORK_ERROR_CODE;
  const message = cause instanceof Error ? cause.message : undefined;
  const view = mapReplayError(status, code, message, retentionDays);
  // mapReplayError returns null only for 200, which a rejected mutation never is.
  const fallback: ReplayErrorView = view ?? {
    kind: 'unexpected',
    title: 'Replay failed',
    hint: message ?? 'The API answered outside the replay contract (02 §6).',
    retryable: false,
    clearSelection: false,
    disableEditor: false,
  };
  // Spec'd for 504 only (02 §412) — the backend happens to send details on
  // 502 too, and the UI treatment there is banner+retry with no affordance.
  const replayRecordId = fallback.kind === 'timeout' ? extractReplayRecordId(cause) : undefined;
  return replayRecordId === undefined ? fallback : { ...fallback, replayRecordId };
}

/** `details: { replayRecordId }` rides on the 504 ApiError (02 §412) — integer-checked before use. */
function extractReplayRecordId(cause: unknown): number | undefined {
  if (!(cause instanceof ApiError)) return undefined;
  const details = cause.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const value = (details as { replayRecordId?: unknown }).replayRecordId;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
