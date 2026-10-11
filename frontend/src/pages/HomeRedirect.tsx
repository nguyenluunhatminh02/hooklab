import { Navigate } from 'react-router-dom';
import { getLastWorkspaceId } from '../lib/lastWorkspace';

/**
 * `/` route (BUILD_PLAN §5.1): jump to the last opened workspace when the id
 * is still in localStorage, otherwise fall back to the workspace list.
 */
export function HomeRedirect() {
  const lastWorkspaceId = getLastWorkspaceId();
  if (lastWorkspaceId && /^\d+$/.test(lastWorkspaceId)) {
    return <Navigate to={`/w/${lastWorkspaceId}`} replace />;
  }
  return <Navigate to="/workspaces" replace />;
}
