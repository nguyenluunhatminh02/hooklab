import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { sanitizeNextPath } from './nextPath';
import { getToken } from './tokenStorage';

/** Inverse guard for /login + /register: an existing token bounces straight in. */
export function RequireGuest({ children }: PropsWithChildren) {
  const location = useLocation();
  const token = getToken();

  if (token) {
    const next = sanitizeNextPath(new URLSearchParams(location.search).get('next'));
    return <Navigate to={next} replace />;
  }

  return <>{children}</>;
}
