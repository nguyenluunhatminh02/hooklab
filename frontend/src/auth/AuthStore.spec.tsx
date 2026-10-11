import { Component, type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMe, login as apiLogin, register as apiRegister } from '../api/auth';
import { ApiError, HTTP_UNAUTHORIZED } from '../api/httpClient';
import type { AuthResponse, User } from '../api/types';
import { AuthStoreProvider, useAuth } from './AuthStore';
import { TOKEN_STORAGE_KEY } from './tokenStorage';

vi.mock('../api/auth', () => ({
  fetchMe: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
}));

const SIGNED_OUT_TEXT = 'signed-out';

const alice: User = {
  id: 1,
  email: 'alice@hooklab.dev',
  createdAt: '2026-10-08T00:00:00.000Z',
};

const bob: User = {
  id: 2,
  email: 'bob@hooklab.dev',
  createdAt: '2026-10-09T00:00:00.000Z',
};

function authResponseFor(user: User, accessToken: string): AuthResponse {
  return { accessToken, tokenType: 'Bearer', user };
}

/** Prints the signed-in email and drives every context action through a button. */
function AuthProbe() {
  const { user, login, register, logout } = useAuth();
  return (
    <div>
      <p data-testid="auth-email">{user ? user.email : SIGNED_OUT_TEXT}</p>
      <button type="button" onClick={() => void login('alice@hooklab.dev', 'hunter2')}>
        Sign in
      </button>
      <button type="button" onClick={() => void register('bob@hooklab.dev', 'hunter2')}>
        Create account
      </button>
      <button type="button" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}

function LoginProbe() {
  const location = useLocation();
  return <p data-testid="login-location">{`${location.pathname}${location.search}`}</p>;
}

function renderAuthStore() {
  render(
    <MemoryRouter initialEntries={['/workspaces']}>
      <AuthStoreProvider>
        <AuthProbe />
        <Routes>
          {/* Silences the router's "no routes matched" warning for the home path. */}
          <Route path="/workspaces" element={<span />} />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </AuthStoreProvider>
    </MemoryRouter>,
  );
}

/**
 * A promise the test can settle explicitly, so boot assertions run only after
 * the store's `.catch` has actually executed — never on a pending promise.
 */
function deferredFetchMe(): { reject: (error: unknown) => void; resolve: (user: User) => void } {
  let resolve!: (user: User) => void;
  let reject!: (error: unknown) => void;
  vi.mocked(fetchMe).mockReturnValue(
    new Promise<User>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
  );
  return { resolve, reject };
}

/** Minimal boundary so the useAuth guard's throw is asserted, not a console dump. */
class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message };
  }

  render() {
    if (this.state.message !== null) {
      return <p role="alert">{this.state.message}</p>;
    }
    return this.props.children;
  }
}

describe('AuthStoreProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not call fetchMe when no token is stored', () => {
    renderAuthStore();

    expect(screen.getByTestId('auth-email')).toHaveTextContent(SIGNED_OUT_TEXT);
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('sets the user when fetchMe resolves for a stored token', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    const me = deferredFetchMe();

    renderAuthStore();
    expect(fetchMe).toHaveBeenCalledTimes(1);

    await act(async () => {
      me.resolve(alice);
    });

    expect(screen.getByTestId('auth-email')).toHaveTextContent('alice@hooklab.dev');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('stored-token');
  });

  it('leaves the user signed out when fetchMe rejects with a 401 ApiError', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'expired-token');
    const me = deferredFetchMe();

    renderAuthStore();

    await act(async () => {
      me.reject(new ApiError(HTTP_UNAUTHORIZED, 'unauthorized', 'Session expired — sign in again'));
    });

    // The global 401 handler owns token cleanup and the /login redirect;
    // this spec pins only the store's in-memory state after the rejection.
    expect(screen.getByTestId('auth-email')).toHaveTextContent(SIGNED_OUT_TEXT);
  });

  it('keeps the stored token but signs the user out when fetchMe fails with a non-401 error', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'offline-token');
    const me = deferredFetchMe();

    renderAuthStore();

    await act(async () => {
      me.reject(new ApiError(0, 'network_error', 'Cannot reach the HookLab API'));
    });

    expect(screen.getByTestId('auth-email')).toHaveTextContent(SIGNED_OUT_TEXT);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('offline-token');
  });

  it('stores the token and exposes the user after login', async () => {
    vi.mocked(apiLogin).mockResolvedValue(authResponseFor(alice, 'jwt-from-login'));

    renderAuthStore();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByTestId('auth-email')).toHaveTextContent('alice@hooklab.dev');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('jwt-from-login');
    expect(apiLogin).toHaveBeenCalledWith({ email: 'alice@hooklab.dev', password: 'hunter2' });
    // Boot validation must not double-fire against the token login just wrote.
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('stores the token and exposes the user after register', async () => {
    vi.mocked(apiRegister).mockResolvedValue(authResponseFor(bob, 'jwt-from-register'));

    renderAuthStore();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByTestId('auth-email')).toHaveTextContent('bob@hooklab.dev');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('jwt-from-register');
    expect(apiRegister).toHaveBeenCalledWith({ email: 'bob@hooklab.dev', password: 'hunter2' });
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('clears the token, drops the user, and navigates to /login on logout', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    const me = deferredFetchMe();

    renderAuthStore();
    await act(async () => {
      me.resolve(alice);
    });
    expect(screen.getByTestId('auth-email')).toHaveTextContent('alice@hooklab.dev');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    // Exact path: a stray ?next= would still substring-match '/login'.
    expect(screen.getByTestId('login-location').textContent).toBe('/login');
    expect(screen.getByTestId('auth-email')).toHaveTextContent(SIGNED_OUT_TEXT);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe('useAuth', () => {
  it('throws when called outside the provider', () => {
    function OrphanConsumer() {
      useAuth();
      return null;
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <OrphanConsumer />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'useAuth must be used inside AuthStoreProvider',
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
