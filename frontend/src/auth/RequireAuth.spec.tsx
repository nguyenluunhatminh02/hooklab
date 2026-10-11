import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { RequireAuth } from './RequireAuth';
import { TOKEN_STORAGE_KEY } from './tokenStorage';

function LoginProbe() {
  const location = useLocation();
  return <div data-testid="login-location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/workspaces"
          element={
            <RequireAuth>
              <div>protected content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  afterEach(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  });

  it('redirects to /login preserving the full path and query as ?next=', () => {
    renderAt('/workspaces?status=verified');

    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.getByTestId('login-location')).toHaveTextContent(
      '/login?next=%2Fworkspaces%3Fstatus%3Dverified',
    );
  });

  it('redirects to /login with next=/ when there is no token and no query', () => {
    renderAt('/workspaces');

    expect(screen.getByTestId('login-location')).toHaveTextContent(
      '/login?next=%2Fworkspaces',
    );
  });

  it('renders children when a token is stored', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'jwt-test-token');

    renderAt('/workspaces?status=verified');

    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-location')).not.toBeInTheDocument();
  });
});
