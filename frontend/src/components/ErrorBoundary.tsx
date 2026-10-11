import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Render errors below this boundary land here instead of a blank page —
 * the fallback always shows the message plus a reload (conventions §3).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <main className="page" role="alert">
        <h1>Something went wrong</h1>
        <p className="form-error">{error.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload the app
        </button>
      </main>
    );
  }
}

/**
 * Process-level safety net: errors thrown outside React (async callbacks,
 * event handlers) would otherwise disappear with no diagnostic at all.
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    console.error('Uncaught error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection', event.reason);
  });
}
