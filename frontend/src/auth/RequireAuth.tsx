import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getToken } from './tokenStorage';

/**
 * Route guard (BUILD_PLAN §5.1): no token → `/login?next=<current path+query>`
 * so login can return the user to where they were headed.
 */
export function RequireAuth({ children }: PropsWithChildren) {
  const location = useLocation();
  const token = getToken();

  if (!token) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <>{children}</>;
}
