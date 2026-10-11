import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { WorkspaceSummary } from '../api/types';
import { listWorkspaces } from '../api/workspaces';
import { useAuth } from '../auth/AuthStore';
import { queryKeys } from '../hooks/queries';
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

/** Outlet child — reports the matched path so navigation is observable. */
function RouteProbe() {
  const location = useLocation();
  return <p data-testid="route-path">{location.pathname}</p>;
}

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
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
  return queryClient;
}

describe('AppShell', () => {
  const logout = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(useAuth).mockReturnValue({
      user: signedInUser,
      login: vi.fn(),
      register: vi.fn(),
      logout,
    });
  });

  it('links the brand back to the app root', () => {
    renderShell();

    expect(screen.getByRole('link', { name: 'HookLab' })).toHaveAttribute('href', '/');
  });

  it('renders the matched route through its outlet', () => {
    renderShell();

    expect(screen.getByTestId('route-path')).toHaveTextContent('/');
  });

  it('shows the signed-in user email', () => {
    renderShell();

    expect(screen.getByText('a@b.c')).toBeInTheDocument();
  });

  it('falls back to "Signed in" when the store has no user', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      login: vi.fn(),
      register: vi.fn(),
      logout,
    });

    renderShell();

    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByText('a@b.c')).not.toBeInTheDocument();
  });

  it('calls logout when Sign out is clicked', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('hides the switcher while the workspace list is loading, then shows it when data arrives', async () => {
    let resolveWorkspaces: (value: WorkspaceSummary[]) => void = () => undefined;
    vi.mocked(listWorkspaces).mockReturnValue(
      new Promise<WorkspaceSummary[]>((resolve) => {
        resolveWorkspaces = resolve;
      }),
    );
    renderShell();

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();

    await act(async () => {
      resolveWorkspaces(workspaces);
    });

    expect(await screen.findByRole('combobox', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Acme' })).toBeInTheDocument();
  });

  it('hides the switcher when the workspace list resolves empty', async () => {
    const queryClient = renderShell();

    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.workspaces)?.status).toBe('success');
    });
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();
  });

  it('lists one option per workspace once the list arrives', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue(workspaces);
    renderShell();

    await screen.findByRole('combobox', { name: 'Workspace' });

    expect(screen.getAllByRole('option')).toHaveLength(workspaces.length + 1);
    expect(screen.getByRole('option', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Globex' })).toBeInTheDocument();
  });

  it('navigates to the selected workspace, remembers it, and resets the select', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue(workspaces);
    const user = userEvent.setup();
    renderShell();

    const select = await screen.findByRole('combobox', { name: 'Workspace' });
    await user.selectOptions(select, '2');

    expect(screen.getByTestId('route-path')).toHaveTextContent('/w/2');
    expect(localStorage.getItem('hooklab.lastWorkspaceId')).toBe('2');
    expect(select).toHaveValue('');
  });
});
