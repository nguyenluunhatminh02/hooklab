import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, HTTP_FORBIDDEN, HTTP_NOT_FOUND } from '../api/httpClient';
import { CopyButton } from '../components/CopyButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MetricsBadges } from '../components/MetricsBadges';
import { RecordDetail } from '../components/RecordDetail';
import { RetentionNotice } from '../components/RetentionNotice';
import { SecretRevealModal } from '../components/SecretRevealModal';
import { SubscriberForm, type SubscriberFormValues } from '../components/SubscriberForm';
import { TimelineList } from '../components/TimelineList';
import { TimelineTabs } from '../components/TimelineTabs';
import { SearchInput } from '../components/SearchInput';
import { Toast } from '../components/Toast';
import { SEARCH_DEBOUNCE_MS } from '../config';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useDocumentVisibility } from '../hooks/useDocumentVisibility';
import { useTimeline, type TimelineTab } from '../hooks/useTimeline';
import { describeStoredAuth } from '../lib/destinationAuth';
import {
  useDeleteSubscriber,
  useRecordDetail,
  useRevokeSubscriber,
  useRotateSubscriber,
  useSubscriber,
  useSubscriberStats,
  useUpdateSubscriber,
  useWorkspaces,
} from '../hooks/queries';
import { NotFoundPage } from './NotFoundPage';

type PendingAction = 'rotate' | 'revoke' | 'delete' | null;

function isMembershipError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === HTTP_FORBIDDEN || error.status === HTTP_NOT_FOUND)
  );
}

export function SubscriberDetailPage() {
  const params = useParams<{ workspaceId: string; subscriberId: string }>();
  const workspaceId = Number.parseInt(params.workspaceId ?? '', 10);
  const subscriberId = Number.parseInt(params.subscriberId ?? '', 10);
  const navigate = useNavigate();

  const subscriberQuery = useSubscriber(
    subscriberId,
    Number.isInteger(workspaceId) && Number.isInteger(subscriberId),
  );
  const workspaces = useWorkspaces();
  const updateSubscriber = useUpdateSubscriber(subscriberId);
  const rotate = useRotateSubscriber(subscriberId);
  const revoke = useRevokeSubscriber(subscriberId);
  const remove = useDeleteSubscriber(subscriberId);

  // A 403/404 on the subscriber itself is terminal (see the early return
  // below) — the dependent timeline/stats queries must stop polling with it,
  // or the "Subscriber unavailable" page keeps 404ing /records and /stats
  // every 2 s forever once retryOnServerError gives up.
  const subscriberMissing =
    subscriberQuery.isError && isMembershipError(subscriberQuery.error);

  // --- P7 timeline wiring -------------------------------------------------
  const [statusTab, setStatusTab] = useState<TimelineTab>('all');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const visible = useDocumentVisibility();
  const timeline = useTimeline(subscriberId, statusTab, debouncedSearch, {
    enabled: !subscriberMissing,
  });
  // Badges/retention come from the canonical stats call only — never recount
  // the loaded page (replay rows would inflate them, 04 §7).
  const stats = useSubscriberStats(subscriberId, { enabled: !subscriberMissing });

  // Selected record lives in the URL (?record=<id>) so a refresh or shared
  // link lands on the same row (04 §5 step 5).
  const [searchParams, setSearchParams] = useSearchParams();
  const recordParam = searchParams.get('record');
  const recordId = recordParam === null ? null : Number.parseInt(recordParam, 10);
  const recordQuery = useRecordDetail(recordId);

  const [expiredNotice, setExpiredNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string } | null>(null);
  const actionInFlight = useRef(false);

  // Retention deleted the selected record mid-view: drop it from the URL so
  // the list keeps polling without a dead panel, and say why it vanished.
  useEffect(() => {
    if (recordId === null || !Number.isInteger(recordId)) return;
    if (!(recordQuery.error instanceof ApiError) || recordQuery.error.status !== HTTP_NOT_FOUND) {
      return;
    }
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('record');
        return next;
      },
      { replace: true },
    );
    setExpiredNotice('record expired (7-day retention)');
  }, [recordQuery.error, recordId, setSearchParams]);

  if (!Number.isInteger(workspaceId) || !Number.isInteger(subscriberId)) {
    return <NotFoundPage />;
  }

  if (subscriberQuery.isLoading) {
    return (
      <section className="page">
        <p className="muted">Loading subscriber…</p>
      </section>
    );
  }

  if (subscriberQuery.isError && isMembershipError(subscriberQuery.error)) {
    return (
      <section className="page">
        <div className="empty-state">
          <h1>Subscriber unavailable</h1>
          <p>This subscriber does not exist, or your account is not a member of its workspace.</p>
          <Link to="/workspaces">Back to workspaces</Link>
        </div>
      </section>
    );
  }

  if (subscriberQuery.isError || !subscriberQuery.data) {
    return (
      <section className="page">
        <p role="alert" className="form-error">
          {subscriberQuery.error instanceof ApiError
            ? subscriberQuery.error.message
            : 'Could not load the subscriber.'}
        </p>
      </section>
    );
  }

  const subscriber = subscriberQuery.data;
  const workspace = workspaces.data?.find((candidate) => candidate.id === subscriber.workspaceId);
  // rotate/revoke/delete are owner-only (02 §3 matrix) — members never see the buttons.
  const canManage = workspace?.role === 'owner';
  const isRevoked = subscriber.status === 'revoked';

  // `?record=` may point at a non-integer (hand-edited URL) — treat as no selection.
  const selectedRecordId = recordId !== null && Number.isInteger(recordId) ? recordId : null;
  const selectedRecord = selectedRecordId !== null ? recordQuery.data : undefined;
  // A 404 here is the retention race, already handled by the effect above
  // (clear + toast) — never render it as a scary inline error as well.
  const recordNotFound =
    recordQuery.error instanceof ApiError && recordQuery.error.status === HTTP_NOT_FOUND;

  async function handleEdit(values: SubscriberFormValues): Promise<void> {
    setEditError(null);
    setSaved(false);
    try {
      await updateSubscriber.mutateAsync(values);
      setSaved(true);
    } catch (cause) {
      setEditError(cause instanceof ApiError ? cause.message : 'Could not save the subscriber.');
    }
  }

  async function runPendingAction(): Promise<void> {
    // Re-entry guard: React state (`isPending`) only flips on the next render,
    // so a second click in the same frame would otherwise fire the mutation twice.
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    try {
      if (pendingAction === 'rotate') {
        const result = await rotate.mutateAsync();
        setRevealed({ secret: result.secret });
      } else if (pendingAction === 'revoke') {
        await revoke.mutateAsync();
      } else if (pendingAction === 'delete') {
        await remove.mutateAsync();
        navigate(`/w/${workspaceId}`);
        return;
      }
      setPendingAction(null);
    } catch (cause) {
      setActionError(
        cause instanceof ApiError ? cause.message : 'The action could not be completed.',
      );
      setPendingAction(null);
    } finally {
      actionInFlight.current = false;
    }
  }

  // A replay attempt hit 404 (the record left retention mid-view): drop the
  // selection and toast the same story as a polling 404 — never show a
  // lingering inline error for a record that simply got old.
  function handleRecordExpired(): void {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('record');
        return next;
      },
      { replace: true },
    );
    setExpiredNotice('record expired (7-day retention)');
  }

  function openRecord(record: { id: number }): void {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('record', String(record.id));
      return next;
    });
  }

  function closeRecord(): void {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('record');
      return next;
    });
  }

  const confirmCopy: Record<Exclude<PendingAction, null>, { title: string; body: string; label: string }> = {
    rotate: {
      title: 'Rotate the signing secret?',
      body: 'The current secret stops working immediately and the rate-limit window resets. Send the new secret to your webhook sender.',
      label: 'Rotate secret',
    },
    revoke: {
      title: 'Revoke this subscriber?',
      body: 'Ingest starts answering 410 Gone and future requests are not recorded. Existing records stay visible.',
      label: 'Revoke',
    },
    delete: {
      title: 'Delete this subscriber?',
      body: 'The subscriber, its destination and its entire record history are removed. This cannot be undone.',
      label: 'Delete',
    },
  };

  return (
    <section className="page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={`/w/${workspaceId}`}>{workspace?.name ?? 'Workspace'}</Link>
        <span aria-hidden="true"> / </span>
        <span>{subscriber.name}</span>
      </nav>

      <header className="page-header subscriber-header">
        <h1>{subscriber.name}</h1>
        <span className={`chip chip-${subscriber.status}`}>{subscriber.status}</span>

        <div className="endpoint-row">
          <code className="subscriber-url">{subscriber.endpointUrl}</code>
          <CopyButton value={subscriber.endpointUrl} label="Copy URL" />
        </div>
        <p className="muted">
          Secret hint: <code>{subscriber.secretHint}</code> · signature header{' '}
          <code>{subscriber.signatureHeader}</code>
        </p>
        {/* The credential never serializes — only its masked hint does (02 §4). */}
        <p className="muted">
          Destination auth: {describeStoredAuth(subscriber.destination.auth)}
        </p>

        {/*
          Canonical counts only — fed by GET /api/subscribers/:id/stats, never
          by the loaded records page (replays would double-count, 04 §7). While
          stats are still in flight nothing renders: a wrong interim number is
          worse than a briefly absent one.
        */}
        {stats.data ? (
          <MetricsBadges
            metrics={{
              received: stats.data.received,
              verified: stats.data.verified,
              rejected: stats.data.rejected,
            }}
          />
        ) : null}
        <RetentionNotice days={stats.data?.retention.days} notice={stats.data?.retention.notice} />
      </header>

      {canManage ? (
        <div className="action-row">
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => setPendingAction('rotate')}
          >
            Rotate secret
          </button>
          {!isRevoked ? (
            <button type="button" className="btn" onClick={() => setPendingAction('revoke')}>
              Revoke
            </button>
          ) : null}
          <button type="button" className="btn btn-danger-ghost" onClick={() => setPendingAction('delete')}>
            Delete
          </button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="form-error">
          {actionError}
        </p>
      ) : null}

      {expiredNotice ? <Toast message={expiredNotice} onDismiss={() => setExpiredNotice(null)} /> : null}

      <section aria-labelledby="edit-heading" className="page-section">
        {/* tabIndex -1 lets the replay-blocked banner's #edit-heading jump
            move keyboard focus here (same pattern as RecordDetail's heading). */}
        <h2 id="edit-heading" tabIndex={-1}>
          Edit subscriber
        </h2>
        {editError ? (
          <p role="alert" className="form-error">
            {editError}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="form-success">
            Saved.
          </p>
        ) : null}
        <SubscriberForm
          initial={subscriber}
          submitLabel="Save changes"
          submitting={updateSubscriber.isPending}
          onSubmit={handleEdit}
        />
      </section>

      <section aria-labelledby="timeline-heading" className="page-section">
        <h2 id="timeline-heading">Timeline</h2>

        <div className="timeline-controls">
          <TimelineTabs value={statusTab} onChange={setStatusTab} />
          <SearchInput value={searchInput} onChange={setSearchInput} modes="event type, request id" />
        </div>

        {/*
          First page only: the 2 s poll refreshes page 1 newest-first, which
          covers the interview story (live delivery appears without refresh).
          Load-more via meta.nextCursor is still not wired — TimelineList has
          no hasMore/onLoadMore props — so a subscriber with more than one
          page of records only ever sees the newest page here.
        */}
        {timeline.isLoading ? (
          <p className="muted">Loading records…</p>
        ) : timeline.isError ? (
          <p role="alert" className="form-error">
            {timeline.error instanceof ApiError
              ? timeline.error.message
              : 'Could not load the record timeline.'}
          </p>
        ) : (
          <TimelineList
            records={timeline.data?.data ?? []}
            statusTab={statusTab}
            selectedRecordId={selectedRecordId}
            onSelect={openRecord}
            isPaused={!visible}
          />
        )}
      </section>

      {selectedRecordId !== null ? (
        <section className="page-section">
          {selectedRecord ? (
            <RecordDetail
              record={selectedRecord}
              onClose={closeRecord}
              // 410 (04 §6): a revoked subscriber has no live destination, so
              // replay stays visible but disabled with the reason banner.
              replayDisabled={isRevoked}
              replayReason="Replay is disabled for a revoked subscriber — its destination is no longer a live target."
              onExpired={handleRecordExpired}
              retentionDays={stats.data?.retention.days}
              // 504 (04 §6): open the saved attempt row as its own detail view.
              onOpenRecord={(recordId) => openRecord({ id: recordId })}
            />
          ) : recordQuery.isLoading ? (
            <p className="muted">Loading record…</p>
          ) : recordQuery.isError && !recordNotFound ? (
            <p role="alert" className="form-error">
              {recordQuery.error instanceof ApiError
                ? recordQuery.error.message
                : 'Could not load the record.'}
            </p>
          ) : null}
        </section>
      ) : null}

      {pendingAction ? (
        <ConfirmDialog
          danger
          title={confirmCopy[pendingAction].title}
          body={confirmCopy[pendingAction].body}
          confirmLabel={confirmCopy[pendingAction].label}
          submitting={rotate.isPending || revoke.isPending || remove.isPending}
          onConfirm={runPendingAction}
          onCancel={() => setPendingAction(null)}
        />
      ) : null}

      {revealed ? (
        <SecretRevealModal
          kind="rotated"
          url={subscriber.endpointUrl}
          token={subscriber.ingestToken}
          secret={revealed.secret}
          onClose={() => setRevealed(null)}
        />
      ) : null}
    </section>
  );
}
