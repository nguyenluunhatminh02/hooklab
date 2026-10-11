import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSubscriber,
  deleteSubscriber,
  fetchSubscriber,
  listSubscribers,
  revokeSubscriber,
  rotateSubscriber,
  updateSubscriber,
} from '../api/subscribers';
import type {
  CreateSubscriberInput,
  SubscriberDetail,
  UpdateSubscriberInput,
} from '../api/types';
import { createWorkspace, listWorkspaces } from '../api/workspaces';
import {
  fetchRecord,
  fetchSubscriberStats,
  type RecordDetail,
  type SubscriberStats,
} from '../api/records';
import type { TimelineTab } from './useTimeline';
import { useDocumentVisibility } from './useDocumentVisibility';
import { POLL_INTERVAL_MS } from '../config';
import { ApiError } from '../api/httpClient';

export const queryKeys = {
  workspaces: ['workspaces'] as const,
  subscribers: (workspaceId: number) => ['subscribers', workspaceId] as const,
  subscriber: (subscriberId: number) => ['subscriber', subscriberId] as const,
  /** Timeline list — keyed by subscriber + filters so a tab/search change swaps the page (04 §5). */
  records: (subscriberId: number, tab: TimelineTab, q: string) =>
    ['records', subscriberId, tab, q] as const,
  /** Metrics badges — canonical counts, deliberately NEVER invalidated by replays (04 §7). */
  stats: (subscriberId: number) => ['stats', subscriberId] as const,
  record: (recordId: number) => ['record', recordId] as const,
};

/**
 * 4xx answers are terminal — a non-member 404 or an expired 401 would otherwise
 * sit through TanStack's default 3 retries (~7s) before the error UI renders.
 * 5xx and network failures (status 0) still get the backoff.
 * Exported so every query in the app (timeline included) shares one rule.
 */
export function retryOnServerError(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status >= 500;
}

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: listWorkspaces,
    retry: retryOnServerError,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createWorkspace({ name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useSubscribers(workspaceId: number) {
  return useQuery({
    queryKey: queryKeys.subscribers(workspaceId),
    queryFn: () => listSubscribers(workspaceId),
    // A malformed route param (NaN) must never reach the API.
    enabled: Number.isInteger(workspaceId),
    retry: retryOnServerError,
  });
}

export function useCreateSubscriber(workspaceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubscriberInput) => createSubscriber(workspaceId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.subscribers(workspaceId) }),
  });
}

export function useSubscriber(subscriberId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.subscriber(subscriberId),
    queryFn: () => fetchSubscriber(subscriberId),
    enabled: enabled && Number.isInteger(subscriberId),
    retry: retryOnServerError,
  });
}

export function useUpdateSubscriber(subscriberId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSubscriberInput) => updateSubscriber(subscriberId, input),
    onSuccess: (updated: SubscriberDetail) => {
      queryClient.setQueryData(queryKeys.subscriber(subscriberId), updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.subscribers(updated.workspaceId),
      });
    },
  });
}

/**
 * Rotate/revoke both change how the subscriber row renders (secretHint/status),
 * so detail and list are invalidated together — never the workspace counts.
 */
export function useRotateSubscriber(subscriberId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rotateSubscriber(subscriberId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriber(subscriberId) });
      const cached = queryClient.getQueryData<SubscriberDetail>(
        queryKeys.subscriber(subscriberId),
      );
      if (cached) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.subscribers(cached.workspaceId),
        });
      }
    },
  });
}

export function useRevokeSubscriber(subscriberId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeSubscriber(subscriberId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriber(subscriberId) });
      const cached = queryClient.getQueryData<SubscriberDetail>(
        queryKeys.subscriber(subscriberId),
      );
      if (cached) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.subscribers(cached.workspaceId),
        });
      }
    },
  });
}

export function useDeleteSubscriber(subscriberId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteSubscriber(subscriberId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriber(subscriberId) });
      const cached = queryClient.getQueryData<SubscriberDetail>(
        queryKeys.subscriber(subscriberId),
      );
      if (cached) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.subscribers(cached.workspaceId),
        });
      }
    },
  });
}

/**
 * Canonical counts for `MetricsBadges` (04 §7): the ONLY source of the three
 * numbers — never derived from a loaded records page (replays would inflate
 * them). Polls on the same 2s cadence as the list while the tab is visible;
 * deliberately excluded from replay invalidation in `useReplay`.
 */
export function useSubscriberStats(subscriberId: number, options: { enabled?: boolean } = {}) {
  const visible = useDocumentVisibility();
  const enabled = Number.isInteger(subscriberId) && (options.enabled ?? true);
  return useQuery<SubscriberStats>({
    queryKey: queryKeys.stats(subscriberId),
    queryFn: () => fetchSubscriberStats(subscriberId),
    enabled,
    refetchInterval: () => (visible && enabled ? POLL_INTERVAL_MS : false),
    staleTime: 0,
    retry: retryOnServerError,
  });
}

/**
 * Opened record for the `?record=` detail panel (04 §5 step 5): polls with the
 * list so a changed body/headers refresh in place, while the selected id in the
 * URL stays put (selection never auto-moves).
 */
export function useRecordDetail(recordId: number | null) {
  const visible = useDocumentVisibility();
  return useQuery<RecordDetail>({
    queryKey: queryKeys.record(recordId ?? 0),
    queryFn: () => fetchRecord(recordId ?? 0),
    enabled: Number.isInteger(recordId) && recordId !== null,
    refetchInterval: () => (visible ? POLL_INTERVAL_MS : false),
    staleTime: 0,
    retry: retryOnServerError,
  });
}
