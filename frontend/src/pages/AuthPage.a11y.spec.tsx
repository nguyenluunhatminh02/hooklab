/**
 * Structural accessibility gate for AuthPage: axe-core over the real rendered
 * surface (roles, labels, aria, heading order, landmarks) in the default
 * sign-in state and while the error alert is shown. Color contrast is out of
 * scope here — jsdom cannot compute rendered colors, and the token-integrity
 * spec (src/styles/tokens.a11y.spec.ts) owns that check.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

const axeOptions = {
  rules: {
    // jsdom has no layout engine, so axe cannot compute rendered colors — real
    // contrast coverage lives in src/styles/tokens.a11y.spec.ts.
    'color-contrast': { enabled: false },
  },
};

function renderAuthPage(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** One line per violation so a failure names the rule and the offending nodes. */
function formatViolations(results: axe.AxeResults): string[] {
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join('; ')}`,
  );
}

describe('AuthPage accessibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('has no structural axe violations in the default sign-in render', async () => {
    const { container } = renderAuthPage('/login');

    const results = await axe.run(container, axeOptions);

    expect(formatViolations(results)).toEqual([]);
  }, 15000);

  it('has no structural axe violations while the error alert is shown', async () => {
    loginMock.mockRejectedValue(
      new ApiError(401, 'invalid_credentials', 'Email or password is incorrect'),
    );
    const { container } = renderAuthPage('/login');
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');

    const results = await axe.run(container, axeOptions);

    expect(formatViolations(results)).toEqual([]);
  }, 15000);
});
