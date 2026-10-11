/**
 * WorkspaceListPage contract: every list-query state (loading, ApiError vs
 * generic failure, empty, rows) plus the create form's flow — empty/whitespace
 * validation before any API call, the trimmed name sent to POST /workspaces,
 * navigation to the new workspace, and the remembered id that `/` reads back.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/httpClient';
import { createWorkspace, listWorkspaces } from '../api/workspaces';
import type { WorkspaceSummary } from '../api/types';
import { getLastWorkspaceId } from '../lib/lastWorkspace';
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

/** Prints pathname so a navigation out of the list page is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

/**
 * `retryDelay: 0` collapses the exponential backoff a plain Error earns from
 * `retryOnServerError` (~7 s in production) so its fallback test stays instant;
 * the hooks' own `retry` function still overrides the default shown here.
 */
function renderListPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workspaces']}>
        <Routes>
          <Route path="/workspaces" element={<WorkspaceListPage />} />
          <Route path="/w/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Default fixture is an empty list — settle the query before driving the form. */
async function renderWithEmptyList(): Promise<void> {
  renderListPage();
  await screen.findByText(EMPTY_LIST_COPY);
}

describe('WorkspaceListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue([]);
  });

  it('shows the loading copy while the list query is still in flight', () => {
    vi.mocked(listWorkspaces).mockReturnValue(
      new Promise<WorkspaceSummary[]>(() => undefined),
    );

    renderListPage();

    expect(screen.getByText('Loading workspaces…')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_LIST_COPY)).not.toBeInTheDocument();
  });

  it('shows the ApiError message when the list query fails', async () => {
    vi.mocked(listWorkspaces).mockRejectedValue(
      // 403 is terminal for retryOnServerError — the alert must render at once.
      new ApiError(403, 'not_a_member', 'You are not a member of any workspace'),
    );

    renderListPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are not a member of any workspace',
    );
  });

  it('falls back to the generic copy when the list failure is not an ApiError', async () => {
    vi.mocked(listWorkspaces).mockRejectedValue(new Error('socket hang up'));

    renderListPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workspaces.');
  });

  it('shows the empty state when the account has no workspaces', async () => {
    renderListPage();

    expect(await screen.findByText(EMPTY_LIST_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders each row with its name, role chip, and subscriber/received counts', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([acme, beta]);

    renderListPage();

    expect(await screen.findByText('Acme production')).toBeInTheDocument();
    expect(screen.getByText('owner')).toHaveClass('chip', 'chip-owner');
    expect(screen.getByText('3 subscribers · 120 received')).toBeInTheDocument();
    expect(screen.getByText('Beta staging')).toBeInTheDocument();
    expect(screen.getByText('member')).toHaveClass('chip', 'chip-member');
    expect(screen.getByRole('link', { name: /Acme production/ })).toHaveAttribute(
      'href',
      '/w/42',
    );
  });

  it('blocks creation when the name is empty', async () => {
    await renderWithEmptyList();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Workspace name is required.');
    expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
  });

  it('blocks creation when the name is only whitespace', async () => {
    await renderWithEmptyList();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('New workspace name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Workspace name is required.');
    expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
  });

  it('creates with the trimmed name, navigates to the workspace, and remembers it', async () => {
    vi.mocked(createWorkspace).mockResolvedValue(acme);
    await renderWithEmptyList();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('New workspace name'), '  Acme production  ');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(vi.mocked(createWorkspace)).toHaveBeenCalledWith({ name: 'Acme production' });
    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/w/42');
    expect(getLastWorkspaceId()).toBe('42');
  });

  it('shows the ApiError message when the create mutation fails', async () => {
    vi.mocked(createWorkspace).mockRejectedValue(
      new ApiError(409, 'name_taken', 'A workspace named Acme already exists'),
    );
    await renderWithEmptyList();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('New workspace name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A workspace named Acme already exists',
    );
    // A failed create must neither navigate nor be remembered for `/`.
    expect(screen.queryByTestId('location-probe')).not.toBeInTheDocument();
    expect(getLastWorkspaceId()).toBeNull();
  });

  it('disables the create button with the pending label while the mutation is in flight', async () => {
    let rejectCreate!: (reason: unknown) => void;
    const inFlight = new Promise<WorkspaceSummary>((_resolve, reject) => {
      rejectCreate = reject;
    });
    vi.mocked(createWorkspace).mockReturnValue(inFlight);
    await renderWithEmptyList();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('New workspace name'), 'Acme production');
    const submitButton = screen.getByRole('button', { name: 'Create workspace' });
    await user.click(submitButton);

    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveTextContent('Creating…');
    expect(vi.mocked(createWorkspace)).toHaveBeenCalledWith({ name: 'Acme production' });

    // Settled from the test body, not the click: rejecting keeps the page mounted
    // (resolving would navigate it away), so the re-enable is assertable.
    await act(async () => {
      rejectCreate(new ApiError(409, 'name_taken', 'A workspace named Acme already exists'));
    });
    expect(submitButton).toBeEnabled();
    expect(submitButton).toHaveTextContent('Create workspace');
  });

  it('remembers the workspace when a row link is clicked', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([acme]);
    renderListPage();
    const user = userEvent.setup();

    const rowLink = await screen.findByRole('link', { name: /Acme production/ });
    await user.click(rowLink);

    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/w/42');
    expect(getLastWorkspaceId()).toBe('42');
  });
});
