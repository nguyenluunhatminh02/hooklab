import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  listSubscriberRecords,
  listWorkspaceRecords,
  type RecordListResponse,
} from '../api/records';
import { POLL_INTERVAL_MS } from '../config';
import { retryOnServerError } from './queries';
import { useDocumentVisibility } from './useDocumentVisibility';

export type TimelineTab = 'all' | 'verified' | 'rejected';

/**
 * Polling record list (04 §5): page 1 every `POLL_INTERVAL_MS` while the tab is
 * visible, no requests while hidden, previous page kept across tab/search
 * queryKey swaps so the list never flashes empty.
 *
 * @param q already debounced by the caller (`useDebouncedValue`) — it is part
 *          of the queryKey, so each raw keystroke would otherwise refetch.
 */
export function useTimeline(
  subscriberId: number,
  tab: TimelineTab,
  q: string,
  options: { enabled?: boolean } = {},
) {
  const visible = useDocumentVisibility();
  const enabled = Number.isInteger(subscriberId) && (options.enabled ?? true);

  return useQuery<RecordListResponse>({
    queryKey: ['records', subscriberId, tab, q],
    queryFn: () =>
      listSubscriberRecords(subscriberId, {
        ...(tab === 'all' ? {} : { status: tab }),
        ...(q === '' ? {} : { q }),
      }),
    enabled,
    refetchInterval: () => (visible && enabled ? POLL_INTERVAL_MS : false),
    staleTime: 0,
    placeholderData: keepPreviousData,
    retry: retryOnServerError,
  });
}

/**
 * Workspace-level record search (P7 acceptance: token-prefix across every
 * subscriber in the workspace). Same poll/pause contract as the subscriber
 * timeline; `q` hits the server as the prefix the API defines (02 §5) — the
 * rows come back already filtered, so the list renders them as returned.
 *
 * Enabled only once `q` is non-empty: an unfiltered workspace list is a feature
 * this screen never claims, and without the guard an idle page would poll a
 * query nobody asked for.
 */
export function useWorkspaceRecords(workspaceId: number, q: string, options: { enabled?: boolean } = {}) {
  const visible = useDocumentVisibility();
  const trimmed = q.trim();
  const enabled = Number.isInteger(workspaceId) && trimmed !== '' && (options.enabled ?? true);
  return useQuery<RecordListResponse>({
    queryKey: ['workspace-records', workspaceId, trimmed],
    queryFn: () => listWorkspaceRecords(workspaceId, { q: trimmed }),
    enabled,
    refetchInterval: () => (visible && enabled ? POLL_INTERVAL_MS : false),
    staleTime: 0,
    placeholderData: keepPreviousData,
    retry: retryOnServerError,
  });
}
