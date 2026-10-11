import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fetchMe, login, register } from './auth';
import { setToken } from '../auth/tokenStorage';
import type { AuthResponse } from './types';

/**
 * Auth wrappers (02 §2): register/login are the bare-body exception, /auth/me
 * is the standard `{ data }` envelope. Stubbed at the fetch level so the
 * wrapper's bare flag and the real token→header path are exercised together.
 */

const credentials = { email: 'qa@hooklab.dev', password: 'hunter2' };

const authResponse: AuthResponse = {
  accessToken: 'jwt-issued',
  tokenType: 'Bearer',
  user: { id: 1, email: 'qa@hooklab.dev', createdAt: '2026-10-08T00:00:00.000Z' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('auth api', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastFetch(): { url: string; init: RequestInit } {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error('fetch was never called');
    const [input, init] = call as [RequestInfo | URL, RequestInit];
    return { url: String(input), init };
  }

  it('register POSTs credentials and resolves the raw body (no { data } unwrap)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(authResponse));

    await expect(register(credentials)).resolves.toEqual(authResponse);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/auth/register');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(credentials));
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('login POSTs credentials to /auth/login', async () => {
    fetchMock.mockResolvedValue(jsonResponse(authResponse));

    await expect(login(credentials)).resolves.toEqual(authResponse);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(credentials));
  });

  it('fetchMe GETs /auth/me and unwraps the data envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: authResponse.user }));

    await expect(fetchMe()).resolves.toEqual(authResponse.user);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/auth/me');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('sends no Authorization header when no token is stored', async () => {
    fetchMock.mockResolvedValue(jsonResponse(authResponse));

    await register(credentials);

    expect((lastFetch().init.headers as Headers).get('Authorization')).toBeNull();
  });

  it('attaches the stored token as a Bearer header on authenticated calls', async () => {
    setToken('jwt-test-token');
    fetchMock.mockResolvedValue(jsonResponse({ data: authResponse.user }));

    await fetchMe();

    expect((lastFetch().init.headers as Headers).get('Authorization')).toBe(
      'Bearer jwt-test-token',
    );
  });
});
