const LAST_WORKSPACE_KEY = 'hooklab.lastWorkspaceId';

/** Drives the `/` redirector (BUILD_PLAN §5.1). */
export function rememberLastWorkspaceId(workspaceId: string): void {
  localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
}

export function getLastWorkspaceId(): string | null {
  return localStorage.getItem(LAST_WORKSPACE_KEY);
}
