import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/httpClient';
import { useCreateWorkspace, useWorkspaces } from '../hooks/queries';
import { rememberLastWorkspaceId } from '../lib/lastWorkspace';

export function WorkspaceListPage() {
  const workspaces = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Workspace name is required.');
      return;
    }
    setError(null);
    try {
      const workspace = await createWorkspace.mutateAsync(trimmed);
      setName('');
      rememberLastWorkspaceId(String(workspace.id));
      navigate(`/w/${workspace.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the workspace.');
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Workspaces</h1>
      </header>

      <form className="inline-form" onSubmit={handleCreate}>
        <div className="field">
          <label htmlFor="workspace-name">New workspace name</label>
          <input
            id="workspace-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme production"
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={createWorkspace.isPending}
        >
          {createWorkspace.isPending ? 'Creating…' : 'Create workspace'}
        </button>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
      </form>

      {workspaces.isLoading ? <p className="muted">Loading workspaces…</p> : null}

      {workspaces.isError ? (
        <p role="alert" className="form-error">
          {workspaces.error instanceof ApiError
            ? workspaces.error.message
            : 'Could not load workspaces.'}
        </p>
      ) : null}

      {workspaces.data && workspaces.data.length === 0 ? (
        <div className="empty-state">
          <p>No workspaces yet. Create the first one above.</p>
        </div>
      ) : null}

      {workspaces.data && workspaces.data.length > 0 ? (
        <ul className="workspace-list">
          {workspaces.data.map((workspace) => (
            <li key={workspace.id}>
              <Link
                to={`/w/${workspace.id}`}
                className="workspace-row"
                onClick={() => rememberLastWorkspaceId(String(workspace.id))}
              >
                <span className="workspace-name">{workspace.name}</span>
                <span className={`chip chip-${workspace.role}`}>{workspace.role}</span>
                <span className="muted">
                  {workspace.subscriberCount} subscribers · {workspace.receivedCount} received
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
