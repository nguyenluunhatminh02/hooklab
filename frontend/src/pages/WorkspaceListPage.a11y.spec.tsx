/**
 * Structural accessibility gate for WorkspaceListPage: roles, labels, aria,
 * heading order, and list/link semantics — checked with axe over the real
 * rendered surface (mocks, providers, and router mirror the contract spec).
 * Color contrast is deliberately out of scope here; see findA11yViolations.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/httpClient';
import { listWorkspaces } from '../api/workspaces';
import type { WorkspaceSummary } from '../api/types';
import { WorkspaceListPage } from './WorkspaceListPage';

vi.mock('../api/workspaces', () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));

const acme: WorkspaceSummary = {
  id: 42,
  name: 'Acme production',
  role: 'owner',
  subscriberCount: 3,
  receivedCount: 120,
  createdAt: '2026-10-09T00:00:00.000Z',
};

const beta: WorkspaceSummary = {
  id: 7,
  name: 'Beta staging',
  role: 'member',
  subscriberCount: 0,
  receivedCount: 0,
  createdAt: '2026-10-09T01:00:00.000Z',
};

const EMPTY_LIST_COPY = 'No workspaces yet. Create the first one above.';

function renderListPage(): HTMLElement {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workspaces']}>
        <Routes>
          <Route path="/workspaces" element={<WorkspaceListPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container;
}

/** One readable line per violation: rule id, node count, and offending targets. */
async function findA11yViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    // jsdom has no layout engine, so axe cannot compute rendered colors here;
    // contrast is covered by src/styles/tokens.a11y.spec.ts.
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map(
    (v) =>
      v.id +
      ' (' +
      v.nodes.length +
      '): ' +
      v.nodes.map((n) => n.target.join(' ')).join('; '),
  );
}

describe('WorkspaceListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue([]);
  });

  it('reports no structural accessibility violations for the default render', async () => {
    const container = renderListPage();
    await screen.findByText(EMPTY_LIST_COPY);

    expect(await findA11yViolations(container)).toEqual([]);
  });

  it('reports no structural accessibility violations for the populated list', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([acme, beta]);
    const container = renderListPage();
    await screen.findByText('Acme production');

    expect(await findA11yViolations(container)).toEqual([]);
  });

  it('reports no structural accessibility violations for the list error alert', async () => {
    vi.mocked(listWorkspaces).mockRejectedValue(
      new ApiError(403, 'not_a_member', 'You are not a member of any workspace'),
    );
    const container = renderListPage();
    await screen.findByRole('alert');

    expect(await findA11yViolations(container)).toEqual([]);
  });
});
