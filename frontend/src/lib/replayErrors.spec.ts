import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/httpClient';
import { RETENTION_DAYS_FALLBACK } from '../config';
import { mapReplayError, replayErrorFromCause, type ReplayErrorView } from './replayErrors';

interface MatrixRow {
  transport: string;
  status: number;
  code?: string;
  message?: string;
  expected: null | Partial<ReplayErrorView>;
}

/**
 * One row per cell of the design-04 §6 table, checked against the statuses
 * the 02 §6 contract actually emits — plus the two rows 04 explicitly rules
 * out (401 is global logout, 429 never exists for replay), plus the 413
 * transport cap (probe-verified live: the replay route parses with the same
 * MAX_BODY_BYTES limit as ingest, so an oversized edited body is reachable
 * even though 02 §6 lists handler statuses only).
 */
const REPLAY_MATRIX: MatrixRow[] = [
  {
    transport: '200 success envelope (destination answered)',
    status: 200,
    expected: null,
  },
  {
    transport: '400 replay_target_blocked (SSRF)',
    status: 400,
    code: 'replay_target_blocked',
    message: 'Target blocked',
    expected: {
      kind: 'blocked',
      retryable: false,
      clearSelection: false,
      disableEditor: false,
    },
  },
  {
    transport: '400 validation_error (e.g. array body)',
    status: 400,
    code: 'validation_error',
    message: 'body must be an object',
    expected: { kind: 'unexpected', retryable: false, hint: 'body must be an object' },
  },
  {
    transport: '401 JWT invalid/expired → global logout view',
    status: 401,
    code: 'unauthorized',
    message: 'Session expired — sign in again',
    expected: { kind: 'unauthorized', retryable: false, disableEditor: false },
  },
  {
    transport: '404 record gone to retention',
    status: 404,
    code: 'not_found',
    expected: { kind: 'missing', clearSelection: true, retryable: false },
  },
  {
    transport: '410 subscriber revoked',
    status: 410,
    code: 'subscriber_revoked',
    expected: { kind: 'revoked', disableEditor: true, retryable: false },
  },
  {
    transport: '413 body_too_large (edited body over the 1 MB transport cap)',
    status: 413,
    code: 'body_too_large',
    message: 'request body exceeds 1048576 bytes',
    expected: {
      kind: 'tooLarge',
      retryable: false,
      clearSelection: false,
      disableEditor: false,
      hint: expect.stringContaining('1 MB'),
    },
  },
  {
    transport: '502 replay_upstream_error (transport)',
    status: 502,
    code: 'replay_upstream_error',
    expected: { kind: 'upstream', retryable: true, clearSelection: false },
  },
  {
    transport: '504 replay_timeout',
    status: 504,
    code: 'replay_timeout',
    expected: {
      kind: 'timeout',
      retryable: true,
      hint: expect.stringContaining('10 s'),
    },
  },
  {
    transport: 'network fail (fetch threw, status 0)',
    status: 0,
    code: 'network_error',
    message: 'Cannot reach the HookLab API',
    expected: {
      kind: 'network',
      retryable: true,
      hint: 'Cannot reach the HookLab API',
    },
  },
  {
    transport: '429 is never part of the replay contract (ingest only)',
    status: 429,
    code: 'rate_limited',
    expected: { kind: 'unexpected', retryable: false },
  },
];

describe('mapReplayError', () => {
  for (const row of REPLAY_MATRIX) {
    it(`maps ${row.transport}`, () => {
      const view = mapReplayError(row.status, row.code, row.message);

      if (row.expected === null) {
        expect(view).toBeNull();
        return;
      }

      expect(view).not.toBeNull();
      expect(view).toMatchObject(row.expected);
      expect(view?.title).not.toBe('');
      expect(view?.hint).not.toBe('');
    });
  }

  it('renders the 404 hint with the retention window the server reports, not the fallback', () => {
    const view = mapReplayError(404, 'not_found', undefined, 30);

    expect(view?.kind).toBe('missing');
    expect(view?.hint).toContain('30-day');
    expect(view?.hint).not.toContain('7-day');
  });

  it('falls back to the constant retention window when no server value is given', () => {
    const view = mapReplayError(404);

    expect(view?.hint).toContain(`${RETENTION_DAYS_FALLBACK}-day`);
  });

  it('keeps every banner non-empty and single-purpose across the whole matrix', () => {
    const views = REPLAY_MATRIX.map((row) => mapReplayError(row.status, row.code, row.message))
      .filter((view): view is ReplayErrorView => view !== null);

    const titles = new Set(views.map((view) => view.title));
    expect(titles.size).toBe(views.length);
  });
});

describe('replayErrorFromCause', () => {
  it('passes an ApiError through the same table', () => {
    const view = replayErrorFromCause(
      new ApiError(504, 'replay_timeout', 'Replay timed out', {
        details: { replayRecordId: 7 },
      }),
    );

    expect(view.kind).toBe('timeout');
    expect(view.retryable).toBe(true);
  });

  it('treats a non-API throw as a retryable network failure', () => {
    const view = replayErrorFromCause(new TypeError('Failed to fetch'));

    expect(view.kind).toBe('network');
    expect(view.retryable).toBe(true);
    expect(view.hint).toBe('Failed to fetch');
  });
});
