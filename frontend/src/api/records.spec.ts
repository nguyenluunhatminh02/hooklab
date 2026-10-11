import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  fetchRecord,
  fetchSubscriberStats,
  listSubscriberRecords,
  listWorkspaceRecords,
  replayRecord,
  type ReplaySuccess,
} from './records';

/**
 * Record/stat wrappers (02 §5/§6/§8). These stubs sit at the fetch boundary on
 * purpose: list routes are the only ones that hang query params off the path,
 * so the real URLSearchParams serialization must be visible in the assertion.
 */

const listRow = {
  id: 11,
  subscriberId: 7,
  workspaceId: 1,
  subscriberName: 'acme',
  status: 'verified',
  reason: null,
  eventType: 'shipment.created',
  method: 'POST',
  bodyBytes: 128,
  isReplay: false,
  replayOfId: null,
  replayResponseStatus: null,
  receivedAt: '2026-10-08T12:00:00.000Z',
};

const listEnvelope = {
  data: [listRow],
  meta: { nextCursor: 'eyJpZCI6MTF9', hasMore: true },
};

const recordDetail = {
  ...listRow,
  url: 'https://example.com/webhook/abc',
  headers: { 'content-type': 'application/json' },
  rawBody: '{"order":42}',
  bodyParsed: { order: 42 },
  destination: { method: 'POST', url: 'https://example.com/webhook/abc', headers: {} },
  replays: [],
};

const statsBody = {
  subscriberId: 7,
  received: 5,
  verified: 3,
  rejected: 2,
  replays: 1,
  reasonBreakdown: {
    missing_signature: 0,
    invalid_signature: 0,
    body_too_large: 0,
    rate_limited: 0,
  },
  retention: { days: 7, notice: 'records auto-delete after 7 days', oldestKeptAt: null },
};

const replaySuccess: ReplaySuccess = {
  replayRecordId: 12,
  outcome: 'ok',
  response: { status: 200, body: '{"ok":true}', durationMs: 84 },
  savedAt: '2026-10-08T12:00:01.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('records api', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastFetch(): { url: string; init: RequestInit } {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error('fetch was never called');
    const [input, init] = call as [RequestInfo | URL, RequestInit];
    return { url: String(input), init };
  }

  it('listSubscriberRecords omits the query string and keeps the whole envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(listEnvelope));

    // Both `data` and `meta` survive — with the default unwrap the cursor would
    // be dropped and pagination would break.
    await expect(listSubscriberRecords(7)).resolves.toEqual(listEnvelope);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/subscribers/7/records');
    expect(init.method).toBe('GET');
  });

  it('serializes every list filter in order: q, status, cursor, limit, includeReplays', async () => {
    fetchMock.mockResolvedValue(jsonResponse(listEnvelope));

    await listSubscriberRecords(7, {
      q: 'order paid',
      status: 'rejected',
      cursor: 'eyJpZCI6MTF9=',
      limit: 25,
      includeReplays: true,
    });

    expect(lastFetch().url).toBe(
      '/api/subscribers/7/records' +
        '?q=order+paid&status=rejected&cursor=eyJpZCI6MTF9%3D&limit=25&includeReplays=true',
    );
  });

  it('drops an empty q and a falsy includeReplays flag', async () => {
    fetchMock.mockResolvedValue(jsonResponse(listEnvelope));

    await listSubscriberRecords(7, { q: '', status: 'verified', includeReplays: false });

    expect(lastFetch().url).toBe('/api/subscribers/7/records?status=verified');
  });

  it('listWorkspaceRecords uses the workspace route with the same query contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse(listEnvelope));

    await expect(listWorkspaceRecords(1, { q: 'ship&drop' })).resolves.toEqual(listEnvelope);

    expect(lastFetch().url).toBe('/api/workspaces/1/records?q=ship%26drop');
  });

  it('fetchRecord GETs the record by id and unwraps data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: recordDetail }));

    await expect(fetchRecord(11)).resolves.toEqual(recordDetail);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/records/11');
    expect(init.method).toBe('GET');
  });

  it('fetchSubscriberStats GETs the per-subscriber stats route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: statsBody }));

    await expect(fetchSubscriberStats(7)).resolves.toEqual(statsBody);

    expect(lastFetch().url).toBe('/api/subscribers/7/stats');
  });

  it('replayRecord POSTs the body under a body key to the replay route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: replaySuccess }));

    await expect(replayRecord(11, { order: 99 })).resolves.toEqual(replaySuccess);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/records/11/replay');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ body: { order: 99 } }));
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });
});
