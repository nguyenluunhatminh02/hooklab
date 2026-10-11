import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { HomeRedirect } from './HomeRedirect';
import { rememberLastWorkspaceId } from '../lib/lastWorkspace';

/**
 * `/` landing contract (BUILD_PLAN §5.1): bounce to the remembered workspace
 * only while its stored id is still a plain integer, otherwise show the list.
 */

function WorkspaceProbe() {
  const location = useLocation();
  return <div data-testid="workspace-location">{location.pathname}</div>;
}

function renderAtHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/workspaces" element={<div>workspaces page</div>} />
        <Route path="/w/:workspaceId" element={<WorkspaceProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HomeRedirect', () => {
  it('redirects to the remembered workspace when the stored id is numeric', () => {
    rememberLastWorkspaceId('7');

    renderAtHome();

    expect(screen.getByTestId('workspace-location')).toHaveTextContent('/w/7');
    expect(screen.queryByText('workspaces page')).not.toBeInTheDocument();
  });

  it('falls back to /workspaces when no workspace was remembered', () => {
    renderAtHome();

    expect(screen.getByText('workspaces page')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-location')).not.toBeInTheDocument();
  });

  it.each(['abc', '3.5', '-1'])(
    'falls back to /workspaces for the invalid stored id %s',
    (storedId) => {
      rememberLastWorkspaceId(storedId);

      renderAtHome();

      expect(screen.getByText('workspaces page')).toBeInTheDocument();
      expect(screen.queryByTestId('workspace-location')).not.toBeInTheDocument();
    },
  );
});
