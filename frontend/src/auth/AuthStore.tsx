import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchMe, login as apiLogin, register as apiRegister } from '../api/auth';
import {
  ApiError,
  HTTP_UNAUTHORIZED,
  setUnauthorizedHandler,
} from '../api/httpClient';
import type { User } from '../api/types';
import { clearToken, getToken, setToken } from './tokenStorage';

interface AuthContextValue {
  user: User | null;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string) => Promise<User>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loginRedirectTarget(): string {
  const next = `${window.location.pathname}${window.location.search}`;
  return `/login?next=${encodeURIComponent(next)}`;
}

export function AuthStoreProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const navigate = useNavigate();

  // One 401 interception point for the whole app (04 §5 step 7).
  // useLayoutEffect, not useEffect: child effects (route queries) run before
  // parent passive effects, so a plain effect would register the handler too
  // late for a 401 on the very first request. Layout effects flush first.
  useLayoutEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setUser(null);
      if (!window.location.pathname.startsWith('/login')) {
        navigate(loginRedirectTarget(), { replace: true });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // Boot: validate the stored token once; the session lives in memory from here.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((error: unknown) => {
        // 401 is already handled by the global handler (token cleared, redirect).
        // Any other failure (offline boot) keeps the token — per-page queries
        // surface the outage where the user actually needs it.
        if (error instanceof ApiError && error.status === HTTP_UNAUTHORIZED) return;
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<User> => {
    const auth = await apiLogin({ email, password });
    setToken(auth.accessToken);
    setUser(auth.user);
    return auth.user;
  }, []);

  const register = useCallback(async (email: string, password: string): Promise<User> => {
    const auth = await apiRegister({ email, password });
    setToken(auth.accessToken);
    setUser(auth.user);
    return auth.user;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo(
    () => ({ user, login, register, logout }),
    [user, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside AuthStoreProvider');
  }
  return context;
}
