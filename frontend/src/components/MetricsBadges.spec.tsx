import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import { MetricsBadges } from './MetricsBadges';
import { useSubscriberStats } from '../hooks/queries';
import { useTimeline } from '../hooks/useTimeline';

/**
 * Canonical-count regression (04 §7): the badges are fed from
 * `useSubscriberStats` only. A replay success invalidates `['records']`
 * (the real `useReplay` call) — that must leave the rendered numbers byte for
 * byte unchanged, even while the records list itself refetches.
 */

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response);

const statsBody = {
  subscriberId: 7,
  received: 5,
  verified: 3,
  rejected: 2,
  replays: 1,
  reasonBreakdown: { missing_signature: 0, invalid_signature: 0, body_too_large: 0, rate_limited: 0 },
  retention: { days: 7, notice: 'records auto-delete after 7 days', oldestKeptAt: null },
};

const listBody = {
  data: [
    {
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
    },
  ],
  meta: { nextCursor: null, hasMore: false },
};

/** Labels + digits with whitespace stripped — exact, formatting-proof. */
function badgeText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, '');
}

function countRecordsCalls(fetchMock: Mock): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/records')).length;
}

/** Mirrors the page wiring: stats → badges, records list mounted beside it. */
function PageProbe() {
  useTimeline(7, 'all', '');
  const stats = useSubscriberStats(7);
  if (!stats.data) return <p className="muted">Loading stats…</p>;
  return (
    <MetricsBadges
      metrics={{
        received: stats.data.received,
        verified: stats.data.verified,
        rejected: stats.data.rejected,
      }}
    />
  );
}

describe('MetricsBadges', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the numbers delivered by GET /api/subscribers/:id/stats', async () => {
    const fetchMock: Mock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      // apiRequest unwraps payload.data for the (non-enveloped) stats route,
      // while list routes receive the whole {data, meta} body as-is.
      return Promise.resolve(url.includes('/stats') ? okJson({ data: statsBody }) : okJson(listBody));
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    render(<PageProbe />, { wrapper: Wrapper });
    const badges = await screen.findByLabelText('Record metrics');

    // The stats payload says 5/3/2 while the records page holds a single row —
    // if the component ever recounted the list, these could not all hold.
    expect(badgeText(badges)).toBe('Received5Verified3Rejected2');
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/stats'))).toBe(true);
  });

  it('regression: rendered counts are unchanged after a replay invalidates the records query', async () => {
    const fetchMock: Mock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(url.includes('/stats') ? okJson({ data: statsBody }) : okJson(listBody));
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    render(<PageProbe />, { wrapper: Wrapper });
    const badges = await screen.findByLabelText('Record metrics');
    const before = badgeText(badges);
    expect(before).toBe('Received5Verified3Rejected2');

    const recordsCallsBefore = countRecordsCalls(fetchMock);
    // Exactly what useReplay fires on success — ['records'] prefix, never ['stats'].
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['records'] });
    });

    // The invalidation must be real: the records list refetched...
    await waitFor(() => expect(countRecordsCalls(fetchMock)).toBeGreaterThan(recordsCallsBefore));

    // ...and the badges did not move a single digit.
    expect(badgeText(screen.getByLabelText('Record metrics'))).toBe(before);
  });
});

describe('MetricsBadges wrap (320px)', () => {
  it('uses flex-wrap: wrap so narrow containers can become single-column in layout', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
    document.head.appendChild(style);
    render(<MetricsBadges metrics={{ received: 5, verified: 3, rejected: 2 }} />);
    const dl = screen.getByLabelText('Record metrics');
    expect(getComputedStyle(dl).flexWrap).toBe('wrap');
    document.head.removeChild(style);
  });
});
