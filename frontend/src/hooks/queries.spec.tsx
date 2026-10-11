import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import { ApiError } from '../api/httpClient';
import type {
  CreatedSubscriber,
  RevokeResult,
  RotateResult,
  SubscriberDetail,
  SubscriberSummary,
  UpdateSubscriberInput,
  WorkspaceSummary,
} from '../api/types';
import { POLL_INTERVAL_MS } from '../config';
import {
  queryKeys,
  retryOnServerError,
  useCreateSubscriber,
  useCreateWorkspace,
  useDeleteSubscriber,
  useRecordDetail,
  useRevokeSubscriber,
  useRotateSubscriber,
  useSubscriber,
  useSubscribers,
  useSubscriberStats,
  useUpdateSubscriber,
} from './queries';

/**
 * Query-layer contract (04 §5/§7): the shared retry rule, the queryKey shapes
 * that cache identity depends on, the NaN-id guards, and the exact
 * invalidation/setQueryData each mutation fires on success.
 */

const workspace: WorkspaceSummary = {
  id: 1,
  name: 'Acme',
  role: 'owner',
  subscriberCount: 1,
  receivedCount: 5,
  createdAt: '2026-10-08T00:00:00.000Z',
};

const subscriberSummary: SubscriberSummary = {
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
};

const subscriberDetail: SubscriberDetail = { ...subscriberSummary, secretHint: '...abc' };

const createdSubscriber: CreatedSubscriber = { ...subscriberDetail, secret: 'whsec_full_secret' };

const rotateResult: RotateResult = {
  secret: 'whsec_rotated',
  secretHint: '...ated',
  rotatedAt: '2026-10-09T00:00:00.000Z',
  note: 'previous secret is now invalid',
};

const revokeResult: RevokeResult = {
  revokedAt: '2026-10-09T00:00:00.000Z',
  note: 'replay disabled',
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

const recordDetail = {
  ...subscriberSummary,
  id: 11,
  url: 'https://hooks.example/shipments',
  headers: { 'content-type': 'application/json' },
  rawBody: '{"event":"shipment.created"}',
  bodyParsed: { event: 'shipment.created' },
  destination: null,
  replays: [],
};

/** apiRequest only reads status/ok/text — a bare object keeps the stub honest. */
function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The non-enveloped routes go through `{ data }` unwrap in apiRequest. */
function enveloped(body: unknown): Response {
  return okJson({ data: body });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** jsdom keeps `visibilityState` read-only, so the test owns the getter. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('retryOnServerError', () => {
  it('stops at the third failure regardless of the error', () => {
    expect(retryOnServerError(3, new ApiError(503, 'upstream_unavailable', 'down'))).toBe(false);
    expect(retryOnServerError(4, new Error('anything'))).toBe(false);
  });

  it('retries a network failure (status 0) and any 5xx', () => {
    expect(retryOnServerError(0, new ApiError(0, 'network_error', 'offline'))).toBe(true);
    expect(retryOnServerError(0, new ApiError(500, 'internal_error', 'boom'))).toBe(true);
    expect(retryOnServerError(1, new ApiError(503, 'upstream_unavailable', 'down'))).toBe(true);
  });

  it('treats 4xx as terminal', () => {
    expect(retryOnServerError(0, new ApiError(400, 'validation_error', 'bad body'))).toBe(false);
    expect(retryOnServerError(0, new ApiError(401, 'unauthorized', 'expired'))).toBe(false);
    expect(retryOnServerError(0, new ApiError(404, 'not_found', 'gone'))).toBe(false);
  });

  it('retries non-ApiError failures', () => {
    expect(retryOnServerError(0, new Error('unexpected'))).toBe(true);
    expect(retryOnServerError(2, 'a thrown string')).toBe(true);
  });
});

describe('queryKeys', () => {
  it('builds the exact tuple shapes the cache identity depends on', () => {
    expect(queryKeys.workspaces).toEqual(['workspaces']);
    expect(queryKeys.subscribers(1)).toEqual(['subscribers', 1]);
    expect(queryKeys.subscriber(7)).toEqual(['subscriber', 7]);
    expect(queryKeys.records(7, 'verified', 'ship')).toEqual(['records', 7, 'verified', 'ship']);
    expect(queryKeys.stats(7)).toEqual(['stats', 7]);
    expect(queryKeys.record(11)).toEqual(['record', 11]);
  });

  it('swaps the records key when the tab or search changes', () => {
    expect(queryKeys.records(7, 'all', '')).not.toEqual(queryKeys.records(7, 'verified', ''));
    expect(queryKeys.records(7, 'all', 'ship')).not.toEqual(queryKeys.records(7, 'all', ''));
  });
});

describe('subscriber queries', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useSubscribers stays disabled for a NaN workspace id', () => {
    const { result } = renderHook(() => useSubscribers(Number.NaN), {
      wrapper: createWrapper(createQueryClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useSubscriber stays disabled for a NaN subscriber id', () => {
    const { result } = renderHook(() => useSubscriber(Number.NaN), {
      wrapper: createWrapper(createQueryClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useSubscriber honors an explicit enabled=false for an integer id', () => {
    const { result } = renderHook(() => useSubscriber(7, false), {
      wrapper: createWrapper(createQueryClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useRecordDetail stays disabled for a NaN record id', () => {
    const { result } = renderHook(() => useRecordDetail(Number.NaN), {
      wrapper: createWrapper(createQueryClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useSubscribers fetches the workspace list once the id is an integer', async () => {
    fetchMock.mockResolvedValue(enveloped([subscriberSummary]));

    const { result } = renderHook(() => useSubscribers(1), {
      wrapper: createWrapper(createQueryClient()),
    });

    await waitFor(() => expect(result.current.data).toEqual([subscriberSummary]));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/1/subscribers', expect.anything());
  });

  it('useRecordDetail requests the record over the record route', async () => {
    fetchMock.mockResolvedValue(enveloped(recordDetail));

    const { result } = renderHook(() => useRecordDetail(11), {
      wrapper: createWrapper(createQueryClient()),
    });

    await waitFor(() => expect(result.current.data?.id).toBe(11));
    expect(fetchMock).toHaveBeenCalledWith('/api/records/11', expect.anything());
  });
});

describe('useCreateWorkspace', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped(workspace)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the name and invalidates the workspaces list on success', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const fetchMock = globalThis.fetch as Mock;

    const { result } = renderHook(() => useCreateWorkspace(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync('Acme');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.anything());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Acme' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces });
  });
});

describe('useCreateSubscriber', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped(createdSubscriber)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the input and invalidates that workspace subscriber list', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const fetchMock = globalThis.fetch as Mock;
    const input = { name: 'payments', destinationUrl: 'https://example.com/webhook/abc' };

    const { result } = renderHook(() => useCreateSubscriber(1), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/1/subscribers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscribers(1) });
  });
});

describe('useUpdateSubscriber', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped(subscriberDetail)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('patches the detail, writes it into the cache, and invalidates the list', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
    const fetchMock = globalThis.fetch as Mock;
    const input: UpdateSubscriberInput = { name: 'payments-v2' };

    const { result } = renderHook(() => useUpdateSubscriber(7), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/subscribers/7');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(setQueryDataSpy).toHaveBeenCalledWith(queryKeys.subscriber(7), subscriberDetail);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscribers(1) });
  });
});

describe('useRotateSubscriber', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped(rotateResult)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rotates and invalidates the detail plus the list of the cached workspace', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(queryKeys.subscriber(7), subscriberDetail);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const fetchMock = globalThis.fetch as Mock;

    const { result } = renderHook(() => useRotateSubscriber(7), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/subscribers/7/rotate');
    expect(init.method).toBe('POST');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscriber(7) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscribers(1) });
  });

  it('skips the list invalidation when no subscriber detail is cached', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRotateSubscriber(7), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscriber(7) });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useRevokeSubscriber', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped(revokeResult)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('revokes and invalidates the detail plus the list of the cached workspace', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(queryKeys.subscriber(7), subscriberDetail);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const fetchMock = globalThis.fetch as Mock;

    const { result } = renderHook(() => useRevokeSubscriber(7), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/subscribers/7/revoke');
    expect(init.method).toBe('POST');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscriber(7) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscribers(1) });
  });
});

describe('useDeleteSubscriber', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' } as unknown as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deletes and invalidates the detail plus the list of the cached workspace', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(queryKeys.subscriber(7), subscriberDetail);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const fetchMock = globalThis.fetch as Mock;

    const { result } = renderHook(() => useDeleteSubscriber(7), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/subscribers/7');
    expect(init.method).toBe('DELETE');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscriber(7) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.subscribers(1) });
  });
});

describe('useSubscriberStats polling', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    fetchMock = vi.fn().mockResolvedValue(enveloped(statsBody));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibility('visible');
  });

  it('fetches on mount and polls on the configured interval', async () => {
    renderHook(() => useSubscriberStats(7), { wrapper: createWrapper(createQueryClient()) });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/subscribers/7/stats');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pauses while the document is hidden and resumes when visible again', async () => {
    renderHook(() => useSubscriberStats(7), { wrapper: createWrapper(createQueryClient()) });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never polls when options.enabled is false', async () => {
    renderHook(() => useSubscriberStats(7, { enabled: false }), {
      wrapper: createWrapper(createQueryClient()),
    });
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never polls for a NaN subscriber id', async () => {
    renderHook(() => useSubscriberStats(Number.NaN), { wrapper: createWrapper(createQueryClient()) });
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
