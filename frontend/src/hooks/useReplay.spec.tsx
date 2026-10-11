import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { replayRecord, type ReplaySuccess } from '../api/records';
import { useReplay } from './useReplay';

/**
 * Replay mutation contract (04 §5 step 6 / §7): the POST forwards the client
 * body untouched, and success invalidates the records list + the record detail
 * while the metrics key must stay untouched — badges come from the canonical
 * count and a replay row must never bump them.
 */

vi.mock('../api/records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/records')>();
  return { ...actual, replayRecord: vi.fn() };
});

const replaySuccess: ReplaySuccess = {
  replayRecordId: 99,
  outcome: 'ok',
  response: { status: 200, body: '{"ok":true}', durationMs: 12 },
  savedAt: '2026-10-09T12:00:00.000Z',
};

const replayBody = { body: '{"event":"shipment.created"}' };

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Every key `useReplay`'s onSuccess could possibly touch, seeded up-front. */
function seedCache(queryClient: QueryClient, subscriberId: number, recordId: number): void {
  queryClient.setQueryData(['records', subscriberId, 'all', ''], { data: [], meta: {} });
  queryClient.setQueryData(['record', recordId], { id: recordId });
  queryClient.setQueryData(['stats', subscriberId], { received: 5, verified: 3, rejected: 2 });
}

function invalidatedKeys(queryClient: QueryClient): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.isInvalidated)
    .map((query) => String(query.queryKey[0]))
    .sort();
}

describe('useReplay', () => {
  beforeEach(() => {
    vi.mocked(replayRecord).mockReset();
    vi.mocked(replayRecord).mockResolvedValue(replaySuccess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the record id and the untouched body to replayRecord', async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useReplay(42), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync(replayBody);
    });

    expect(replayRecord).toHaveBeenCalledTimes(1);
    expect(replayRecord).toHaveBeenCalledWith(42, replayBody);
    // The observer's success state lands on a later notify — wait for it.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(replaySuccess);
  });

  it('invalidates records and the record detail on success, never the stats key', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    seedCache(queryClient, 7, 42);

    const { result } = renderHook(() => useReplay(42), { wrapper: createWrapper(queryClient) });
    await act(async () => {
      await result.current.mutateAsync(replayBody);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['records'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['record', 42] });
    // Exactly those two calls — anything a third call would cover is a bug.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);

    // Cache-side proof: both record caches were marked stale...
    expect(invalidatedKeys(queryClient)).toEqual(['record', 'records']);
    // ...while the canonical stats row was not.
    expect(queryClient.getQueryState(['stats', 7])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(['stats', 7])).toEqual({
      received: 5,
      verified: 3,
      rejected: 2,
    });
  });

  it('surfaces the failure without invalidating anything', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(replayRecord).mockRejectedValue(new Error('replay failed'));
    seedCache(queryClient, 7, 42);

    const { result } = renderHook(() => useReplay(42), { wrapper: createWrapper(queryClient) });
    await act(async () => {
      await expect(result.current.mutateAsync(replayBody)).rejects.toThrow('replay failed');
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(invalidatedKeys(queryClient)).toEqual([]);
  });
});
