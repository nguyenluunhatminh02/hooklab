import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { RequireGuest } from './RequireGuest';
import { setToken, TOKEN_STORAGE_KEY } from './tokenStorage';

/**
 * Inverse guard contract: /login and /register must render for visitors
 * without a token, and bounce an already signed-in visitor to the sanitized
 * `?next=` target (never an off-origin path).
 */

function RedirectProbe() {
  const location = useLocation();
  return <div data-testid="redirect-location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/login"
          element={
            <RequireGuest>
              <div>guest form</div>
            </RequireGuest>
          }
        />
        <Route path="/workspaces" element={<RedirectProbe />} />
        <Route path="/w/:workspaceId" element={<RedirectProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireGuest', () => {
  afterEach(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  });

  it('renders children when no token is stored', () => {
    renderAt('/login');

    expect(screen.getByText('guest form')).toBeInTheDocument();
    expect(screen.queryByTestId('redirect-location')).not.toBeInTheDocument();
  });

  it('redirects an authenticated visitor to the sanitized ?next= path', () => {
    setToken('jwt-test-token');

    renderAt('/login?next=%2Fw%2F9');

    expect(screen.getByTestId('redirect-location')).toHaveTextContent('/w/9');
    expect(screen.queryByText('guest form')).not.toBeInTheDocument();
  });

  it('redirects to /workspaces when there is no next parameter', () => {
    setToken('jwt-test-token');

    renderAt('/login');

    expect(screen.getByTestId('redirect-location')).toHaveTextContent('/workspaces');
  });

  it('rejects a protocol-relative next and falls back to /workspaces', () => {
    setToken('jwt-test-token');

    renderAt('/login?next=%2F%2Fevil');

    expect(screen.getByTestId('redirect-location')).toHaveTextContent('/workspaces');
  });
});
