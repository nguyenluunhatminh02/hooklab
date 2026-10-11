import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkspaceOverviewPage } from './WorkspaceOverviewPage';

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response);

const workspaces = [
  {
    id: 1,
    name: 'Acme',
    role: 'owner',
    subscriberCount: 1,
    receivedCount: 5,
    createdAt: '2026-10-08T00:00:00.000Z',
  },
];

const subscriber = {
  id: 7,
  workspaceId: 1,
  name: 'payments',
  status: 'active',
  endpointUrl: 'https://example.com/webhook/abc',
  ingestToken: 'pay_7d3d8128d6a8',
  destination: { method: 'POST', url: 'https://example.com/webhook/abc', headers: {}, auth: { type: 'none' } },
  signatureHeader: 'x-hooklab-signature',
  receivedCount: 2,
  verifiedCount: 1,
  rejectedCount: 1,
  createdAt: '2026-10-08T00:00:00.000Z',
  revokedAt: null,
  secretHint: '...abc',
};

const statsBody = {
  subscriberId: 7,
  received: 5,
  verified: 3,
  rejected: 2,
  replays: 1,
  reasonBreakdown: { missing_signature: 0, invalid_signature: 0, body_too_large: 0, rate_limited: 0 },
  retention: { days: 7, notice: 'records auto-delete after 7 days', oldestKeptAt: null },
};

describe('WorkspaceOverviewPage token-prefix search', () => {
  let fetchMock: Mock;

  function Wrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/w/1']}>
          <Routes>
            <Route path="/w/:workspaceId" element={children} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/workspaces')) return Promise.resolve(okJson({ data: workspaces }));
      if (url.endsWith('/api/workspaces/1/subscribers')) return Promise.resolve(okJson({ data: [subscriber] }));
      if (url.includes('/api/workspaces/1/records')) {
        // Simulate server returning a row whose eventType lacks the token needle
        // but server still matched via token prefix; treat as empty here for a
        // "no records match" case, or could return the row — the second test
        // explicitly checks server-empty renders 'No records match'.
        return Promise.resolve(okJson({ data: [], meta: { nextCursor: null, hasMore: false } }));
      }
      if (url.includes('/stats')) return Promise.resolve(okJson({ data: statsBody }));
      return Promise.resolve(okJson({ data: null }));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests records with q when searching and renders "No records match" on empty response', async () => {
    render(<WorkspaceOverviewPage />, { wrapper: Wrapper });
    const user = userEvent.setup();

    const q = 'pay_7d3d8128d6a8';
    await user.type(screen.getByRole('searchbox', { name: /token prefix/i }), q);

    await waitFor(
      () => {
        const call = fetchMock.mock.calls.find(
          ([input]) => String(input).includes('/api/workspaces/1/records'),
        );
        expect(call).toBeDefined();
      },
      { timeout: 2000 },
    );

    const recCall = fetchMock.mock.calls.find(
      ([input]) => String(input).includes('/api/workspaces/1/records'),
    );
    expect(recCall).toBeDefined();
    const recUrl = String(recCall?.[0]);
    expect(recUrl).toContain('/api/workspaces/1/records?q=');
    expect(recUrl).toContain(encodeURIComponent(q));

    await waitFor(() => expect(screen.getByText('No records match')).toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it('renders the retention notice with the exact contract copy', async () => {
    // This page has no stats call (stats is per-subscriber, 02 §8), so the
    // component composes the fallback from the 7-day constant — which must
    // read identically to the server's RETENTION_NOTICE.
    render(<WorkspaceOverviewPage />, { wrapper: Wrapper });
    await screen.findByText('payments');
    expect(screen.getByText('records auto-delete after 7 days')).toBeInTheDocument();
  });

  it('does not request workspace records while the search is blank', async () => {
    render(<WorkspaceOverviewPage />, { wrapper: Wrapper });

    // Wait for the page's own data to settle, then give a hypothetical
    // disabled-but-fetching query time to fire — neither should produce a
    // records call while the box is empty.
    await screen.findByText('payments');
    await waitFor(() => {
      const recCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/api/workspaces/1/records'),
      ).length;
      expect(recCalls).toBe(0);
    });
  });
});
