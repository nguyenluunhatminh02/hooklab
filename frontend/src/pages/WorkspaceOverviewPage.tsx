import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, HTTP_FORBIDDEN, HTTP_NOT_FOUND } from '../api/httpClient';
import { RetentionNotice } from '../components/RetentionNotice';
import { SecretRevealModal } from '../components/SecretRevealModal';
import { SearchInput } from '../components/SearchInput';
import { SubscriberForm, type SubscriberFormValues } from '../components/SubscriberForm';
import { TimelineList } from '../components/TimelineList';
import { SEARCH_DEBOUNCE_MS } from '../config';
import { useCreateSubscriber, useSubscribers, useWorkspaces } from '../hooks/queries';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useDocumentVisibility } from '../hooks/useDocumentVisibility';
import { useWorkspaceRecords } from '../hooks/useTimeline';
import { rememberLastWorkspaceId } from '../lib/lastWorkspace';
import { NotFoundPage } from './NotFoundPage';

function isMembershipError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === HTTP_FORBIDDEN || error.status === HTTP_NOT_FOUND)
  );
}

export function WorkspaceOverviewPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = Number.parseInt(params.workspaceId ?? '', 10);
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const subscribers = useSubscribers(workspaceId);
  const createSubscriber = useCreateSubscriber(workspaceId);
  const [createError, setCreateError] = useState<string | null>(null);

  // Workspace-level record search (P7 acceptance: token-prefix across
  // subscribers). Only fires once the debounced box is non-empty; rows come
  // back filtered by the server, so the list renders them as received.
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const hasSearch = debouncedSearch.trim() !== '';
  const recordSearch = useWorkspaceRecords(workspaceId, debouncedSearch);
  const visible = useDocumentVisibility();

  const [revealed, setRevealed] = useState<{
    url: string;
    token: string;
    secret: string;
  } | null>(null);

  useEffect(() => {
    if (Number.isInteger(workspaceId)) {
      rememberLastWorkspaceId(String(workspaceId));
    }
  }, [workspaceId]);

  if (!Number.isInteger(workspaceId)) return <NotFoundPage />;

  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId);
  if (workspaces.isSuccess && !workspace) {
    return (
      <section className="page">
        <div className="empty-state">
          <h1>Not a member</h1>
          <p>This workspace does not exist, or your account is not a member of it.</p>
          <Link to="/workspaces">Back to workspaces</Link>
        </div>
      </section>
    );
  }

  async function handleCreate(values: SubscriberFormValues): Promise<void> {
    setCreateError(null);
    try {
      const created = await createSubscriber.mutateAsync(values);
      setRevealed({
        url: created.endpointUrl,
        token: created.ingestToken,
        secret: created.secret,
      });
    } catch (cause) {
      setCreateError(cause instanceof ApiError ? cause.message : 'Could not create the subscriber.');
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>{workspace?.name ?? `Workspace ${workspaceId}`}</h1>
        <RetentionNotice />
      </header>

      <section aria-labelledby="subscribers-heading" className="page-section">
        <h2 id="subscribers-heading">Subscribers</h2>

        {subscribers.isLoading ? <p className="muted">Loading subscribers…</p> : null}

        {subscribers.isError && isMembershipError(subscribers.error) ? (
          <div className="empty-state">
            <p>You are not a member of this workspace.</p>
            <Link to="/workspaces">Back to workspaces</Link>
          </div>
        ) : null}

        {subscribers.isError && !isMembershipError(subscribers.error) ? (
          <p role="alert" className="form-error">
            {subscribers.error instanceof ApiError
              ? subscribers.error.message
              : 'Could not load subscribers.'}
          </p>
        ) : null}

        {subscribers.data && subscribers.data.length === 0 ? (
          <div className="empty-state">
            <p>No subscribers yet — create the first one below.</p>
          </div>
        ) : null}

        {subscribers.data && subscribers.data.length > 0 ? (
          <ul className="subscriber-list">
            {subscribers.data.map((subscriber) => (
              <li key={subscriber.id}>
                <Link to={`/w/${workspaceId}/subscribers/${subscriber.id}`} className="subscriber-row">
                  <span className="subscriber-name">{subscriber.name}</span>
                  <span className={`chip chip-${subscriber.status}`}>{subscriber.status}</span>
                  <code className="subscriber-url">{subscriber.endpointUrl}</code>
                  <span className="muted">
                    {subscriber.receivedCount} received · {subscriber.rejectedCount} rejected
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="record-search-heading" className="page-section">
        <h2 id="record-search-heading">Search records</h2>
        {/*
          Token-prefix search across every subscriber in the workspace (02 §5
          `q`). The server does the filtering; selecting a hit deep-links to the
          subscriber's own timeline at ?record=<id>.
        */}
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          label="Search records by token prefix"
          modes="event type, token, request id"
        />
        {hasSearch ? (
          recordSearch.isLoading ? (
            <p className="muted">Searching…</p>
          ) : recordSearch.isError ? (
            <p role="alert" className="form-error">
              {recordSearch.error instanceof ApiError
                ? recordSearch.error.message
                : 'Could not search records.'}
            </p>
          ) : (
            <TimelineList
              records={recordSearch.data?.data ?? []}
              statusTab="all"
              selectedRecordId={null}
              onSelect={(record) =>
                navigate(`/w/${workspaceId}/subscribers/${record.subscriberId}?record=${record.id}`)
              }
              isPaused={!visible}
            />
          )
        ) : null}
      </section>

      <section aria-labelledby="add-subscriber-heading" className="page-section">
        <h2 id="add-subscriber-heading">Add subscriber</h2>
        {createError ? (
          <p role="alert" className="form-error">
            {createError}
          </p>
        ) : null}
        <SubscriberForm
          submitLabel="Create subscriber"
          submitting={createSubscriber.isPending}
          onSubmit={handleCreate}
        />
      </section>

      {revealed ? (
        <SecretRevealModal
          kind="created"
          url={revealed.url}
          token={revealed.token}
          secret={revealed.secret}
          onClose={() => setRevealed(null)}
        />
      ) : null}
    </section>
  );
}
