/**
 * `?next=` only ever carries an in-app path. Reject protocol-relative (`//evil`)
 * and absolute URLs so a crafted login link cannot bounce the user off-origin.
 * Also reject backslashes that can cause the path to resolve off-origin.
 */
export const DEFAULT_AUTHED_PATH = '/workspaces';

export function sanitizeNextPath(raw: string | null): string {
  if (!raw) return DEFAULT_AUTHED_PATH;
  if (raw.includes('\\')) return DEFAULT_AUTHED_PATH;
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_AUTHED_PATH;
  return raw;
}
