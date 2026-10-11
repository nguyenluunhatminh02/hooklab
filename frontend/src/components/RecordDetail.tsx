import { useEffect, useRef } from 'react';
import type { RecordDetail as RecordDetailData, ReplayChild } from '../api/records';
import { useReplay } from '../hooks/useReplay';
import { replayErrorFromCause } from '../lib/replayErrors';
import { HeadersTable } from './HeadersTable';
import { JsonView } from './JsonView';
import { ReplayComparison, type ReplayComparisonOriginal } from './ReplayComparison';
import { ReplayEditor } from './ReplayEditor';
import { StatusBadge } from './StatusBadge';
import '../styles/replay.css';

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface RecordDetailProps {
  record: RecordDetailData;
  onClose: () => void;
  /** Subscriber revoked → replay answers 410; editor stays visible but disabled (04 §6). */
  replayDisabled?: boolean;
  /** Required with replayDisabled — the visible reason banner (04 §6 410 row). */
  replayReason?: string;
  /** A replay attempt hit 404 (retention ate the record mid-view): page clears ?record= + toasts. */
  onExpired?: () => void;
  /** `stats.retention.days` — feeds the 404 hint; the fallback constant covers a missing stats call. */
  retentionDays?: number;
  /** 504 (04 §6): open the saved attempt row (`details.replayRecordId`) as its own detail view. */
  onOpenRecord?: (recordId: number) => void;
}

/**
 * `?record=` detail panel (04 §4): status + reject-reason badges, the full
 * captured header whitelist (02 §5.1) and the raw body through `JsonView`.
 * Escape and the close/back controls all return to the list — the URL param is
 * owned by the page, so `onClose` just clears it.
 */
export function RecordDetail({
  record,
  onClose,
  replayDisabled = false,
  replayReason,
  onExpired,
  retentionDays,
  onOpenRecord,
}: RecordDetailProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus lands on the heading when the panel opens: on the ≤768px full-width
  // layout the list scrolls away, so keyboard focus must follow the view.
  // Mount-only on purpose — re-focusing on every 2s poll/selection would yank
  // focus out of the timeline's roving tabindex.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <section className="record-detail" aria-labelledby="record-detail-heading" data-testid="record-detail">
      <header className="record-detail-header">
        <button type="button" className="btn record-back" onClick={onClose}>
          ← Timeline
        </button>
        <h2 id="record-detail-heading" tabIndex={-1} ref={headingRef}>
          Request detail
        </h2>
        <StatusBadge status={record.status} />
        {record.reason ? <span className="chip chip-rejected">{record.reason}</span> : null}
        {record.isReplay ? <span className="chip">replay</span> : null}
        <button type="button" className="btn btn-ghost record-close" onClick={onClose}>
          Close
        </button>
      </header>

      <dl className="record-detail-meta">
        <div>
          <dt>Received</dt>
          <dd>{formatTimestamp(record.receivedAt)}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd className="record-detail-request">
            {record.method} {record.url}
          </dd>
        </div>
        <div>
          <dt>Event type</dt>
          <dd>{record.eventType ?? '(no event type)'}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{record.bodyBytes} B</dd>
        </div>
        {record.destination ? (
          <div>
            <dt>Destination</dt>
            <dd className="record-detail-request">
              {record.destination.method} {record.destination.url}
            </dd>
          </div>
        ) : null}
        {record.replayResponseStatus !== null ? (
          <div>
            <dt>Replay response</dt>
            <dd>{record.replayResponseStatus}</dd>
          </div>
        ) : null}
      </dl>

      <section aria-labelledby="record-headers-heading" className="record-detail-section">
        <h3 id="record-headers-heading">Headers</h3>
        <HeadersTable headers={record.headers} />
      </section>

      <section aria-labelledby="record-body-heading" className="record-detail-section">
        <h3 id="record-body-heading">Request body</h3>
        <JsonView raw={record.rawBody} />
      </section>

      {/*
        Keyed by record id: switching records remounts the section, which is
        what clears the mutation state. Without it a success/error from the
        previous record (or one still in flight, resolved after the switch)
        would render under the new record.
      */}
      <ReplaySection
        key={record.id}
        record={record}
        disabled={replayDisabled}
        reason={replayReason}
        onExpired={onExpired}
        retentionDays={retentionDays}
        onOpenRecord={onOpenRecord}
      />
    </section>
  );
}

interface ReplaySectionProps {
  record: RecordDetailData;
  disabled: boolean;
  reason?: string;
  onExpired?: () => void;
  retentionDays?: number;
  onOpenRecord?: (recordId: number) => void;
}

/**
 * Replay block (04 §4/§6): the edited body is the only thing the client sends
 * (C18) — destination method/URL/headers come from the subscriber row — so the
 * editor is one textarea preset with the captured body. After submit the
 * section renders either the round-trip comparison (destination answered, any
 * upstream status is a *result*) or one banner mapped from the transport error.
 */
function ReplaySection({
  record,
  disabled,
  reason,
  onExpired,
  retentionDays,
  onOpenRecord,
}: ReplaySectionProps) {
  const replay = useReplay(record.id);
  const failure =
    replay.isError && replay.error !== null
      ? replayErrorFromCause(replay.error, retentionDays)
      : null;
  const shouldClearSelection = failure?.clearSelection === true;
  // 410 (04 §6): the editor stays mounted but disabled, and its reason line is
  // the banner — rendering the alert too would say the same thing twice.
  const editorDisabled = disabled || (failure?.disableEditor ?? false);
  const editorReason = disabled
    ? reason
    : failure?.disableEditor === true
      ? failure.hint
      : undefined;
  // 504 affordance (04 §6): captured as a local so the click closure sees the
  // narrowed number instead of an optional property.
  const openAttemptId = failure?.replayRecordId;

  // 404: the record left retention mid-view — hand control back to the page,
  // which clears the selection and toasts the same story as a polling 404
  // (04 §5 step 5). The page unmounts this section on that state change.
  useEffect(() => {
    if (shouldClearSelection) onExpired?.();
  }, [shouldClearSelection, onExpired]);

  const original: ReplayComparisonOriginal = {
    method: record.method,
    url: record.url,
    rawBody: record.rawBody,
    status: record.status,
    reason: record.reason,
  };

  // Round trip straight from the mutation response: the request half mirrors
  // the record the same way records.mapper nests a stored child (01 §4), and
  // the 200 envelope's top-level `outcome` moves inside `response` where
  // ReplayChild keeps it. URL = the destination that was targeted (replay
  // rows carry replayTargetUrl; 01 §137 §185) — for a replay row of the
  // source record, that is exactly record.destination.url.
  const destinationUrl = record.destination?.url ?? record.url;
  const freshChild: ReplayChild | null =
    replay.data !== undefined
      ? {
          id: replay.data.replayRecordId,
          receivedAt: replay.data.savedAt,
          request: {
            method: record.method,
            url: destinationUrl,
            headers: {},
            rawBody: record.rawBody,
          },
          response: {
            outcome: replay.data.outcome,
            status: replay.data.response.status,
            body: replay.data.response.body,
            durationMs: replay.data.response.durationMs,
          },
        }
      : null;
  // replays[] is ordered asc (records.service) — last = newest attempt. The
  // refetch that useReplay triggers after a success is what lands the attempt
  // here, so the evidence survives a refresh; the fresh mutation result is
  // preferred only while it is at least as new (equal id right after submit).
  const storedChild =
    record.replays.length > 0 ? record.replays[record.replays.length - 1] : null;
  // Strictly newer only: once the refetch lands (equal id) the STORED child is
  // the authority — it carries the capture-time replayTargetUrl snapshot, while
  // the synthesized fresh child reads the subscriber's live destination, which
  // an edit between submit and refetch would have moved.
  const replayChild =
    freshChild !== null && (storedChild === null || freshChild.id > storedChild.id)
      ? freshChild
      : storedChild;

  return (
    <section aria-labelledby="record-replay-heading" className="record-detail-section">
      <h3 id="record-replay-heading">Replay</h3>
      <ReplayEditor
        defaultBody={record.rawBody}
        disabled={editorDisabled}
        reason={editorReason}
        submitting={replay.isPending}
        onSubmit={(body) => replay.mutate(body)}
      />

      {/* 410 is rendered by the editor's own reason line; everything else
          becomes a banner under it. */}
      {failure !== null && !failure.disableEditor ? (
        <div role="alert" className="replay-banner" data-testid="replay-error" data-kind={failure.kind}>
          <p className="replay-banner-title">{failure.title}</p>
          <p className="replay-banner-hint">{failure.hint}</p>
          {/* 400 SSRF block (04 §6): the only fix is editing the destination,
              so the banner jumps to the subscriber edit form on this page. */}
          {failure.kind === 'blocked' ? (
            <a className="replay-banner-link" href="#edit-heading">
              Edit the destination URL
            </a>
          ) : null}
          {/* 504 (04 §6/02 §412): the attempt was saved — `details.replayRecordId`
              opens that row in the timeline, where the round trip can be read.
              The 502 banner has no such affordance (spec: retry only). */}
          {openAttemptId !== undefined ? (
            <button
              type="button"
              className="replay-banner-link"
              onClick={() => onOpenRecord?.(openAttemptId)}
            >
              Open the saved attempt
            </button>
          ) : null}
        </div>
      ) : null}

      {replayChild !== null ? (
        <ReplayComparison original={original} replay={replayChild} />
      ) : null}
    </section>
  );
}
