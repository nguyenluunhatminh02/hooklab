import { describe, expect, it } from 'vitest';
import { getLastWorkspaceId, rememberLastWorkspaceId } from './lastWorkspace';

/** Consumed by HomeRedirect (BUILD_PLAN §5.1) — the stored id drives `/`. */
describe('lastWorkspace', () => {
  it('round-trips a workspace id under the hooklab.lastWorkspaceId key', () => {
    rememberLastWorkspaceId('42');

    expect(localStorage.getItem('hooklab.lastWorkspaceId')).toBe('42');
    expect(getLastWorkspaceId()).toBe('42');
  });

  it('overwrites the previously remembered workspace id', () => {
    rememberLastWorkspaceId('1');
    rememberLastWorkspaceId('2');

    expect(getLastWorkspaceId()).toBe('2');
  });

  it('returns null when no workspace has been remembered', () => {
    expect(getLastWorkspaceId()).toBeNull();
  });
});
