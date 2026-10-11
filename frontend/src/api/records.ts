/**
 * Record timeline + stats wire calls (design 02 §5 / §8, BUILD_PLAN §5.3).
 * Types mirror the contract exactly so a shape drift fails typecheck, not review.
 */
import { apiRequest } from './httpClient';
import type { RecordDestination } from './types';

export type RecordStatus = 'verified' | 'rejected';

export type RejectReason =
  | 'missing_signature'
  | 'invalid_signature'
  | 'body_too_large'
  | 'rate_limited';

export interface RecordListItem {
  id: number;
  subscriberId: number;
  workspaceId: number;
  subscriberName: string;
  status: RecordStatus;
  reason: RejectReason | null;
  eventType: string | null;
  method: string;
  bodyBytes: number;
  isReplay: boolean;
  replayOfId: number | null;
  replayResponseStatus: number | null;
  receivedAt: string;
}

export interface RecordListMeta {
  nextCursor: string | null;
  hasMore: boolean;
  /** Offset mode only (02 §7). */
  total?: number;
}

/** List envelope: `meta` is a sibling of `data`, not inside it (02 §1.2). */
export interface RecordListResponse {
  data: RecordListItem[];
  meta: RecordListMeta;
}

export interface ReplayChild {
  id: number;
  receivedAt: string;
  request: { method: string; url: string; headers: Record<string, string>; rawBody: string };
  response: {
    outcome: 'ok' | 'timeout' | 'upstream_error';
    status: number | null;
    body: string | null;
    durationMs: number;
  };
}

export interface RecordDetail extends RecordListItem {
  url: string;
  /** Whitelisted capture headers only (02 §5.1) — everything else is dropped server-side. */
  headers: Record<string, string>;
  rawBody: string;
  bodyParsed: unknown | null;
  /** The source subscriber's outbound leg as captured — no auth (credential never leaves the subscriber row). */
  destination: RecordDestination | null;
  replays: ReplayChild[];
}

export interface SubscriberStats {
  subscriberId: number;
  received: number;
  verified: number;
  rejected: number;
  replays: number;
  reasonBreakdown: Record<RejectReason, number>;
  retention: {
    days: number;
    notice: string;
    oldestKeptAt: string | null;
  };
}

export interface ListRecordsParams {
  /** Event-type substring, token prefix (workspace route), or exact x-request-id (02 §5). */
  q?: string;
  status?: RecordStatus;
  cursor?: string;
  limit?: number;
  /** 02 §5: defaults to the canonical replayOfId: null filter; no UI toggle yet, kept as contract surface. */
  includeReplays?: boolean;
}

function listQuery(params: ListRecordsParams): string {
  const search = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') search.set('q', params.q);
  if (params.status !== undefined) search.set('status', params.status);
  if (params.cursor !== undefined) search.set('cursor', params.cursor);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.includeReplays) search.set('includeReplays', 'true');
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export function listSubscriberRecords(
  subscriberId: number,
  params: ListRecordsParams = {},
): Promise<RecordListResponse> {
  return apiRequest<RecordListResponse>(
    `/subscribers/${subscriberId}/records${listQuery(params)}`,
    { envelope: true },
  );
}

export function listWorkspaceRecords(
  workspaceId: number,
  params: ListRecordsParams = {},
): Promise<RecordListResponse> {
  return apiRequest<RecordListResponse>(`/workspaces/${workspaceId}/records${listQuery(params)}`, {
    envelope: true,
  });
}

export function fetchRecord(recordId: number): Promise<RecordDetail> {
  return apiRequest<RecordDetail>(`/records/${recordId}`);
}

export function fetchSubscriberStats(subscriberId: number): Promise<SubscriberStats> {
  return apiRequest<SubscriberStats>(`/subscribers/${subscriberId}/stats`);
}

/** 02 §6 success shape — any upstream status is a result, so this is always `outcome: 'ok'`. */
export interface ReplaySuccess {
  replayRecordId: number;
  outcome: 'ok';
  response: { status: number; body: string | null; durationMs: number };
  savedAt: string;
}

/**
 * `ReplayDto` carries only the body (C18): destination method/URL/headers
 * come from the subscriber row, never from the client.
 */
export function replayRecord(
  recordId: number,
  body: Record<string, unknown>,
): Promise<ReplaySuccess> {
  return apiRequest<ReplaySuccess>(`/records/${recordId}/replay`, {
    method: 'POST',
    body: { body },
  });
}
