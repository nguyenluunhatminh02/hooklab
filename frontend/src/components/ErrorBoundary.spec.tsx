import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ErrorBoundary, installGlobalErrorHandlers } from './ErrorBoundary';

/** Child that always throws while rendering — the failure the boundary exists for. */
function Bomb(): never {
  throw new Error('Widget exploded during render');
}

describe('ErrorBoundary', () => {
  // vitest's jsdom environment re-exposes window.location as a configurable
  // accessor, so the reload stub below can be swapped in and the original
  // descriptor restored in afterEach (raw jsdom would refuse the redefinition).
  const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  let consoleError: MockInstance;

  beforeEach(() => {
    // componentDidCatch reports through console.error (React adds its own
    // report of the caught error on top) — silence both for the whole test.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLocation !== undefined) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('renders children untouched when no child throws', () => {
    render(
      <ErrorBoundary>
        <p>healthy content</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('healthy content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the fallback with heading, error message and reload button when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('Widget exploded during render')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the app' })).toBeInTheDocument();
    // componentDidCatch must have logged through the silenced console.error.
    expect(consoleError).toHaveBeenCalledWith(
      'Unhandled render error',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('reloads the window when the reload button is clicked', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });

    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: 'Reload the app' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('installGlobalErrorHandlers', () => {
  let consoleError: MockInstance;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Registering a user 'error' listener first matters: vitest's own window
    // error trap only re-emits to the process when zero user listeners exist,
    // so installing before the dispatch keeps the synthetic event from being
    // treated as a genuinely uncaught exception.
    installGlobalErrorHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a window 'error' event with the thrown error", () => {
    const error = new Error('async callback failed');

    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

    expect(consoleError).toHaveBeenCalledWith('Uncaught error', error);
  });

  it("logs an 'unhandledrejection' event with the rejection reason", () => {
    const reason = new Error('fetch without a catch');
    // jsdom ships no PromiseRejectionEvent constructor — dispatch a plain
    // Event and attach the `reason` field the handler reads.
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: reason });

    window.dispatchEvent(rejection);

    expect(consoleError).toHaveBeenCalledWith('Unhandled promise rejection', reason);
  });
});
