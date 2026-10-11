import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthStore';
import { ApiError } from '../api/httpClient';
import { sanitizeNextPath } from '../auth/nextPath';

interface AuthPageProps {
  mode: 'login' | 'register';
}

export function AuthPage({ mode }: AuthPageProps) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = sanitizeNextPath(new URLSearchParams(location.search).get('next'));
  const isLogin = mode === 'login';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await register(email, password);
      }
      navigate(next, { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Something went wrong — check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const alternatePath = isLogin ? '/register' : '/login';
  const alternateLabel = isLogin ? 'Create an account' : 'Sign in instead';

  return (
    <main className="auth-page">
      <h1>{isLogin ? 'Sign in' : 'Create account'}</h1>

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Working…' : isLogin ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="auth-switch">
        <Link to={`${alternatePath}?next=${encodeURIComponent(next)}`}>{alternateLabel}</Link>
      </p>
    </main>
  );
}
