import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthStore';
import { rememberLastWorkspaceId } from '../lib/lastWorkspace';
import { useWorkspaces } from '../hooks/queries';

function rememberWorkspace(workspaceId: string): void {
  rememberLastWorkspaceId(workspaceId);
}

/** Header chrome for every authenticated route: brand, workspace switcher, user menu. */
export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          HookLab
        </Link>

        {workspaces.data && workspaces.data.length > 0 ? (
          <label className="workspace-switcher">
            <span className="visually-hidden">Workspace</span>
            <select
              value=""
              onChange={(event) => {
                const workspaceId = event.target.value;
                if (workspaceId === '') return;
                rememberWorkspace(workspaceId);
                navigate(`/w/${workspaceId}`);
              }}
            >
              <option value="">Switch workspace…</option>
              {workspaces.data.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="user-menu">
          <span className="user-email">{user?.email ?? 'Signed in'}</span>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
