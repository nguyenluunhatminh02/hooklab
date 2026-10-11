import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './httpClient';
import { createWorkspace, listWorkspaces } from './workspaces';
import type { WorkspaceSummary } from './types';

/** Workspace wrappers (02 §3) — exact method/path/body of the calls they emit. */

vi.mock('./httpClient', () => ({ apiRequest: vi.fn() }));

const apiRequestMock = vi.mocked(apiRequest);

const workspace: WorkspaceSummary = {
  id: 1,
  name: 'Acme',
  role: 'owner',
  subscriberCount: 2,
  receivedCount: 5,
  createdAt: '2026-10-08T00:00:00.000Z',
};

describe('workspaces api', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it('listWorkspaces issues a plain GET of /workspaces and unwraps data', async () => {
    apiRequestMock.mockResolvedValue([workspace]);

    await expect(listWorkspaces()).resolves.toEqual([workspace]);

    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/workspaces');
  });

  it('createWorkspace POSTs the name as the body', async () => {
    apiRequestMock.mockResolvedValue(workspace);

    await expect(createWorkspace({ name: 'Acme' })).resolves.toEqual(workspace);

    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/workspaces', {
      method: 'POST',
      body: { name: 'Acme' },
    });
  });
});
