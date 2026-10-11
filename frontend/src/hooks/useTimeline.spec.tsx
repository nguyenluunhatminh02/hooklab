import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import { useTimeline, type TimelineTab } from './useTimeline';

/**
 * Polling contract (04 §5): initial fetch, 2000 ms refetch while visible,
 * no fetches while the document is hidden, resume when visible again, and a
 * queryKey swap when the tab/search filter changes.
 */

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

/** apiRequest only reads status/ok/text — a bare object keeps the stub honest. */
function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function createWrapper(): ({ children }: { children: ReactNode }) => JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('useTimeline', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue(okJson(listBody));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibility('visible');
  });

  it('fetches on mount and refetches on the 2000 ms poll', async () => {
    renderHook(() => useTimeline(7, 'all', ''), { wrapper: createWrapper() });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/subscribers/7/records');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/subscribers/7/records');
  });

  it('stops polling while the document is hidden and resumes when visible', async () => {
    renderHook(() => useTimeline(7, 'all', ''), { wrapper: createWrapper() });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // Still exactly the mount fetch — the interval must not fire while hidden.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('swaps the queryKey when the tab or search changes', async () => {
    const { rerender } = renderHook(
      ({ tab, q }: { tab: TimelineTab; q: string }) => useTimeline(7, tab, q),
      { wrapper: createWrapper(), initialProps: { tab: 'all' as TimelineTab, q: '' } },
    );
    await flush();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/subscribers/7/records');

    rerender({ tab: 'verified', q: '' });
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/subscribers/7/records?status=verified',
      expect.anything(),
    );

    rerender({ tab: 'verified', q: 'ship' });
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/subscribers/7/records?q=ship&status=verified',
      expect.anything(),
    );
  });

  it('drops the status param when the tab returns to all', async () => {
    const { rerender } = renderHook(
      ({ tab }: { tab: TimelineTab }) => useTimeline(7, tab, ''),
      { wrapper: createWrapper(), initialProps: { tab: 'rejected' as TimelineTab } },
    );
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/subscribers/7/records?status=rejected',
      expect.anything(),
    );

    rerender({ tab: 'all' });
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/subscribers/7/records', expect.anything());
  });

  it('stops polling when enabled becomes false', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useTimeline(7, 'all', '', { enabled }),
      { wrapper: createWrapper(), initialProps: { enabled: true } },
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Poll interval fires once while enabled
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Disable polling
    rerender({ enabled: false });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // Should not have refetched while disabled
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Re-enable resumes polling — the stale query refetches on enable, then
    // the interval takes over again on the next window.
    rerender({ enabled: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
