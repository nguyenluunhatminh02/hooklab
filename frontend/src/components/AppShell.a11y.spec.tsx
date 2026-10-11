import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { WorkspaceSummary } from '../api/types';
import { listWorkspaces } from '../api/workspaces';
import { useAuth } from '../auth/AuthStore';
import { AppShell } from './AppShell';

vi.mock('../auth/AuthStore', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../api/workspaces', () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));

const signedInUser = { id: 1, email: 'a@b.c', createdAt: '2026-10-08T00:00:00.000Z' };

const workspaces: WorkspaceSummary[] = [
  {
    id: 1,
    name: 'Acme',
    role: 'owner',
    subscriberCount: 2,
    receivedCount: 9,
    createdAt: '2026-10-08T00:00:00.000Z',
  },
  {
    id: 2,
    name: 'Globex',
    role: 'member',
    subscriberCount: 0,
    receivedCount: 0,
    createdAt: '2026-10-08T00:00:00.000Z',
  },
];

/** Outlet child — the shell is only valid with routed content inside its main landmark. */
function RouteProbe() {
  const location = useLocation();
  return <p data-testid="route-path">{location.pathname}</p>;
}

const axeOptions = {
  rules: {
    // jsdom has no layout engine, so axe cannot compute rendered colors — real
    // contrast coverage lives in src/styles/tokens.a11y.spec.ts.
    'color-contrast': { enabled: false },
  },
};

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<RouteProbe />} />
            <Route path="/w/:workspaceId" element={<RouteProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(useAuth).mockReturnValue({
      user: signedInUser,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('has no structural axe violations when the workspace list is empty', async () => {
    const { container } = renderShell();

    const results = await axe.run(container, axeOptions);

    expect(
      results.violations.map(
        (violation) =>
          `${violation.id} (${violation.nodes.length}): ${violation.nodes
            .map((node) => node.target.join(' '))
            .join('; ')}`,
      ),
    ).toEqual([]);
  }, 15000);

  it('has no structural axe violations once the workspace switcher renders', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue(workspaces);
    const { container } = renderShell();
    await screen.findByRole('combobox', { name: 'Workspace' });

    const results = await axe.run(container, axeOptions);

    expect(
      results.violations.map(
        (violation) =>
          `${violation.id} (${violation.nodes.length}): ${violation.nodes
            .map((node) => node.target.join(' '))
            .join('; ')}`,
      ),
    ).toEqual([]);
  }, 15000);
});
