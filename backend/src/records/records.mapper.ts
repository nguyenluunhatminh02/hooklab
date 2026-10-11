import { Prisma } from '../generated/prisma/client';
import { RecordStatus, ReplayError } from '../generated/prisma/client';

export type WireRecordStatus = 'verified' | 'rejected';
export type WireRejectReason = 'missing_signature' | 'invalid_signature' | 'rate_limited' | 'body_too_large';
export type ReplayOutcome = 'ok' | 'timeout' | 'upstream_error';

export interface RecordListItem {
  id: number;
  subscriberId: number;
  workspaceId: number;
  subscriberName: string;
  status: WireRecordStatus;
  reason: WireRejectReason | null;
  eventType: string | null;
  method: string;
  bodyBytes: number;
  isReplay: boolean;
  replayOfId: number | null;
  replayResponseStatus: number | null;
  receivedAt: string;
}

export interface ReplayChild {
  id: number;
  receivedAt: string;
  request: { method: string; url: string; headers: Record<string, string>; rawBody: string };
  response: { outcome: ReplayOutcome; status: number | null; body: string | null; durationMs: number };
}

export interface DestinationWire {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface RecordDetail extends RecordListItem {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  bodyParsed: unknown | null;
  destination: DestinationWire;
  replays: ReplayChild[];
}

/** Structural shape of a WebhookRecord row returned by the generated client. */
export interface RecordRow {
  id: number;
  subscriberId: number;
  method: string;
  url: string;
  headers: Prisma.JsonValue;
  rawBody: string;
  status: RecordStatus;
  rejectReason: string | null;
  eventType: string | null;
  bodyBytes: number;
  replayOfId: number | null;
  /** Destination targeted by this replay leg; null on non-replay rows (01 §137). */
  replayTargetUrl: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  replayError: ReplayError | null;
  replayedAt: Date | null;
  durationMs: number | null;
  receivedAt: Date;
}

export interface RecordListRow extends RecordRow {
  subscriber: { workspaceId: number; name: string };
}

export interface RecordDetailRow extends RecordRow {
  subscriber: {
    workspaceId: number;
    name: string;
    destinationMethod: string;
    destinationUrl: string;
    destinationHeaders: Prisma.JsonValue;
  };
  replays: RecordRow[];
}

function headersWire(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  // Capture whitelists header values as strings (ingest.service); a legacy row with
  // a scalar value is dropped rather than typed into the wire shape.
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function bodyParsedWire(rawBody: string): unknown | null {
  try {
    return JSON.parse(rawBody);
  } catch {
    // Non-JSON captures are normal (signed form bodies, plain text) — the wire
    // contract carries null instead of failing the whole detail read.
    return null;
  }
}

function toOutcome(replayError: ReplayError | null): ReplayOutcome {
  if (replayError === null) return 'ok';
  if (replayError === ReplayError.REPLAY_TIMEOUT) return 'timeout';
  // REPLAY_TARGET_BLOCKED never lands in a row (C3 — blocked replays write no record);
  // it shares upstream_error so the enum stays exhaustively handled without a third wire value.
  return 'upstream_error';
}

export function toListItem(row: RecordListRow): RecordListItem {
  return {
    id: row.id,
    subscriberId: row.subscriberId,
    workspaceId: row.subscriber.workspaceId,
    subscriberName: row.subscriber.name,
    status: row.status === RecordStatus.VERIFIED ? 'verified' : 'rejected',
    reason: row.rejectReason === null ? null : (row.rejectReason.toLowerCase() as WireRejectReason),
    eventType: row.eventType,
    method: row.method,
    bodyBytes: row.bodyBytes,
    isReplay: row.replayOfId !== null,
    replayOfId: row.replayOfId,
    replayResponseStatus: row.responseStatus,
    receivedAt: row.receivedAt.toISOString(),
  };
}

export function toReplayChild(row: RecordRow): ReplayChild {
  return {
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    request: {
      method: row.method,
      // `url` is the OUTBOUND leg: the destination actually targeted for this
      // replay (01 schema §137 §185), not a copy of the original ingest URL —
      // the right column of ReplayComparison reads it as "where it went".
      url: row.replayTargetUrl ?? row.url,
      headers: headersWire(row.headers),
      rawBody: row.rawBody,
    },
    response: {
      outcome: toOutcome(row.replayError),
      status: row.responseStatus,
      body: row.responseBody,
      durationMs: row.durationMs ?? 0,
    },
  };
}

export function toRecordDetail(row: RecordDetailRow): RecordDetail {
  const subscriber = row.subscriber;
  const base: RecordListItem = {
    id: row.id,
    subscriberId: row.subscriberId,
    workspaceId: subscriber.workspaceId,
    subscriberName: subscriber.name,
    status: row.status === RecordStatus.VERIFIED ? 'verified' : 'rejected',
    reason: row.rejectReason === null ? null : (row.rejectReason.toLowerCase() as WireRejectReason),
    eventType: row.eventType,
    method: row.method,
    bodyBytes: row.bodyBytes,
    isReplay: row.replayOfId !== null,
    replayOfId: row.replayOfId,
    replayResponseStatus: row.responseStatus,
    receivedAt: row.receivedAt.toISOString(),
  };
  return {
    ...base,
    url: row.url,
    headers: headersWire(row.headers),
    rawBody: row.rawBody,
    bodyParsed: bodyParsedWire(row.rawBody),
    destination: {
      // Live subscriber row, not a capture-time snapshot (02 §5): rotate/edit
      // changes what this detail renders; the type is non-null because the
      // detail query always joins a subscriber.
      method: subscriber.destinationMethod,
      url: subscriber.destinationUrl,
      headers: headersWire(subscriber.destinationHeaders),
    },
    replays: row.replays.map(toReplayChild),
  };
}
