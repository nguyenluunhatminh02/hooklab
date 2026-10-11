import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SubscriberDetailPage } from './SubscriberDetailPage';

/**
 * Membership-error polling contract: a 403/404 on GET /subscribers/:id is
 * terminal (the page renders "Subscriber unavailable" and stops), so the
 * dependent timeline and stats queries must stop polling with it. Before the
 * `enabled` gate they kept firing every 2 s forever — a 404-poll loop the
 * live console log captured (75 lines / 72.5 s on one dead-subscriber view).
 */

const statsBody = {
  subscriberId: 220,
  received: 3,
  verified: 2,
  rejected: 1,
  replays: 0,
  reasonBreakdown: { missing_signature: 1, invalid_signature: 0, body_too_large: 0, rate_limited: 0 },
  retention: { days: 7, notice: 'records auto-delete after 7 days', oldestKeptAt: null },
};

const listBody = { data: [], meta: { nextCursor: null, hasMore: false } };

const subscriberBody = {
  id: 220,
  workspaceId: 180,
  name: 'acme',
  status: 'active',
  endpointUrl: 'http://localhost:3001/ingest/tok_abc',
  ingestToken: 'tok_abc',
  destination: {
    method: 'POST',
    url: 'https://hooks.example/shipments',
    headers: {},
    // A stored credential proves the page renders only the masked hint.
    auth: { type: 'bearer', tokenHint: '…cdef' },
  },
  signatureHeader: 'x-hooklab-signature',
  receivedCount: 3,
  verifiedCount: 2,
  rejectedCount: 1,
  createdAt: '2026-10-08T12:00:00.000Z',
  revokedAt: null,
  secretHint: '…cdef',
};

/** apiRequest only reads status/ok/text — a bare object keeps the stub honest. */
function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorJson(status: number, code: string, message: string): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { code, message } }),
  } as unknown as Response;
}

/**
 * The page must mount through a route match (`useParams`), so the tree is
 * built directly instead of wrapped around RTL's children element.
 */
function renderPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/w/180/subscribers/220']}>
        <Routes>
          <Route
            path="/w/:workspaceId/subscribers/:subscriberId"
            element={<SubscriberDetailPage />}
          />
          <Route path="/workspaces" element={<p>workspaces page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Drain promise chains (query resolution → state → render) without timers. */
async function flushUntil(check: () => boolean, maxFlushes = 25): Promise<void> {
  for (let attempt = 0; attempt < maxFlushes && !check(); attempt += 1) {
    await flush();
  }
  if (!check()) throw new Error('condition never became true after flushing');
}

function countCalls(fetchMock: Mock, pathFragment: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(pathFragment)).length;
}

describe('SubscriberDetailPage polling', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops polling timeline and stats once the subscriber is a membership 404', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/workspaces') return Promise.resolve(okJson({ data: [] }));
      // Subscriber, stats and records all answer 404 for a non-member.
      return Promise.resolve(errorJson(404, 'not_found', 'Subscriber not found'));
    });

    renderPage();
    await flushUntil(() => screen.queryByRole('heading', { name: 'Subscriber unavailable' }) !== null);

    // The mount fired each dependent query once (they were enabled before the
    // subscriber's own 404 landed) — a 404 is terminal, so no retry follows.
    expect(countCalls(fetchMock, '/records')).toBe(1);
    expect(countCalls(fetchMock, '/stats')).toBe(1);

    // Three poll windows: the loop this guards against never starts.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    expect(countCalls(fetchMock, '/records')).toBe(1);
    expect(countCalls(fetchMock, '/stats')).toBe(1);
  });

  it('keeps polling on the 2 s cadence while the subscriber loads normally', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/workspaces') return Promise.resolve(okJson({ data: [] }));
      if (url === '/api/subscribers/220/stats') return Promise.resolve(okJson({ data: statsBody }));
      if (url === '/api/subscribers/220/records') return Promise.resolve(okJson(listBody));
      if (url === '/api/subscribers/220') return Promise.resolve(okJson({ data: subscriberBody }));
      return Promise.resolve(errorJson(404, 'not_found', 'Not found'));
    });

    renderPage();
    await flushUntil(() => screen.queryByRole('heading', { name: 'acme' }) !== null);

    // The credential never serializes — only this masked fragment does (02 §4).
    expect(
      screen.getByText('Destination auth: Bearer (token ends …cdef)'),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // The happy path must still poll — the membership gate never engages here.
    expect(countCalls(fetchMock, '/records')).toBe(2);
    expect(countCalls(fetchMock, '/stats')).toBe(2);
  });
});
