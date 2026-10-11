/**
 * AuthPage contract: mode-specific copy and autocomplete, ?next= sanitization
 * on successful auth, ApiError vs generic failure alerts, and the in-flight
 * submit state (disabled button + pending label, alert cleared on re-submit).
 */
import { act, render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/httpClient';
import type { User } from '../api/types';
import { AuthPage } from './AuthPage';

const { loginMock, registerMock } = vi.hoisted(() => ({
  loginMock: vi.fn<(email: string, password: string) => Promise<User>>(),
  registerMock: vi.fn<(email: string, password: string) => Promise<User>>(),
}));

vi.mock('../auth/AuthStore', () => ({
  useAuth: () => ({ login: loginMock, register: registerMock }),
}));

const alice: User = {
  id: 1,
  email: 'ada@example.com',
  createdAt: '2026-10-09T00:00:00.000Z',
};

/** Prints pathname+search so a navigation out of AuthPage is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

function renderAuthPage(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/workspaces" element={<LocationProbe />} />
        <Route path="/w/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillCredentials(user: UserEvent, email: string, password: string): Promise<void> {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
}

/**
 * A promise settled from the test body, not from the click that started it —
 * keeps the "while pending" window open for assertions before it resolves.
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('AuthPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the sign-in heading, credential fields, and the register link', () => {
    renderAuthPage('/login');

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('mirrors register mode: create-account heading, new-password autocomplete, sign-in link', () => {
    renderAuthPage('/register');

    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toBeInTheDocument();
  });

  it('calls login with the typed values and navigates to the sanitized next path', async () => {
    loginMock.mockResolvedValue(alice);
    renderAuthPage('/login?next=%2Fw%2F3');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(loginMock).toHaveBeenCalledWith('ada@example.com', 'correct horse');
    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/w/3');
  });

  it('navigates to /workspaces when next is absent', async () => {
    loginMock.mockResolvedValue(alice);
    renderAuthPage('/login');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/workspaces');
  });

  it('falls back to /workspaces for a protocol-relative next (//evil)', async () => {
    loginMock.mockResolvedValue(alice);
    renderAuthPage('/login?next=%2F%2Fevil');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/workspaces');
  });

  it('falls back to /workspaces for an absolute-URL next (http://x)', async () => {
    loginMock.mockResolvedValue(alice);
    renderAuthPage('/login?next=http%3A%2F%2Fx');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/workspaces');
  });

  it('renders the ApiError message in an alert', async () => {
    loginMock.mockRejectedValue(
      new ApiError(401, 'invalid_credentials', 'Email or password is incorrect'),
    );
    renderAuthPage('/login');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
  });

  it('renders the generic connection message for a plain Error', async () => {
    loginMock.mockRejectedValue(new Error('socket hang up'));
    renderAuthPage('/login');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong — check your connection and try again.',
    );
  });

  it('disables submit and shows the pending label while login is in flight', async () => {
    const pending = createDeferred<User>();
    loginMock.mockReturnValue(pending.promise);
    renderAuthPage('/login');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'correct horse');
    const submitButton = screen.getByRole('button', { name: 'Sign in' });
    await user.click(submitButton);

    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveTextContent('Working…');
    expect(loginMock).toHaveBeenCalledWith('ada@example.com', 'correct horse');

    // Settled outside the click, so flush through act rather than React's
    // event batching. Rejecting (instead of resolving) keeps AuthPage mounted —
    // a success would navigate and unmount it, leaving the detached node frozen
    // in its last-rendered state — so the finally-block's re-enable is assertable.
    await act(async () => {
      pending.reject(new Error('late failure'));
    });
    expect(submitButton).toBeEnabled();
    expect(submitButton).toHaveTextContent('Sign in');
  });

  it('keeps next URL-encoded on the alternate-mode link', async () => {
    renderAuthPage('/login?next=%2Fw%2F7%3Ftab%3Drecords');
    const user = userEvent.setup();

    const registerLink = screen.getByRole('link', { name: 'Create an account' });
    // Round-trip through decode-then-encode: a raw re-encode would double it
    // to %252F, a dropped query would lose %3Ftab%3Drecords.
    expect(registerLink).toHaveAttribute('href', '/register?next=%2Fw%2F7%3Ftab%3Drecords');

    await user.click(registerLink);
    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute(
      'href',
      '/login?next=%2Fw%2F7%3Ftab%3Drecords',
    );
  });

  it('clears the previous alert before re-attempting a second submit', async () => {
    const secondAttempt = createDeferred<User>();
    loginMock
      .mockRejectedValueOnce(
        new ApiError(401, 'invalid_credentials', 'Email or password is incorrect'),
      )
      .mockReturnValueOnce(secondAttempt.promise);
    renderAuthPage('/login');
    const user = userEvent.setup();

    await fillCredentials(user, 'ada@example.com', 'wrong-password');
    const submitButton = screen.getByRole('button', { name: 'Sign in' });
    await user.click(submitButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');

    await user.click(submitButton);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveTextContent('Working…');
    expect(loginMock).toHaveBeenCalledTimes(2);
    expect(registerMock).not.toHaveBeenCalled();

    await act(async () => {
      secondAttempt.resolve(alice);
    });
    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/workspaces');
  });
});
