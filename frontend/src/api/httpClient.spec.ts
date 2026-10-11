import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, apiRequest, setUnauthorizedHandler } from './httpClient';
import { setToken } from '../auth/tokenStorage';

/**
 * Wire contract (02 §1.2): one `{ data }` unwrap, one error→ApiError mapping,
 * one Authorization header source. Everything here runs against a stubbed
 * global fetch, so the assertions are about apiRequest's behaviour alone.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function rawResponse(raw: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
  } as unknown as Response;
}

describe('apiRequest', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  /** The last fetch call as url + init; fails loudly if nothing was sent. */
  function lastFetch(): { url: string; init: RequestInit } {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error('fetch was never called');
    const [input, init] = call as [RequestInfo | URL, RequestInit];
    return { url: String(input), init };
  }

  function lastHeaders(): Headers {
    return lastFetch().init.headers as Headers;
  }

  /** Rejection reason as an ApiError — throws if the call resolves instead. */
  async function captureRejection(run: () => Promise<unknown>): Promise<ApiError> {
    const outcome = await run().then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ApiError);
    return outcome as ApiError;
  }

  it('unwraps the { data } envelope and sends a plain GET by default', async () => {
    const workspaces = [{ id: 1, name: 'Acme' }];
    fetchMock.mockResolvedValue(jsonResponse({ data: workspaces }));

    await expect(apiRequest('/workspaces')).resolves.toEqual(workspaces);

    const { url, init } = lastFetch();
    expect(url).toBe('/api/workspaces');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('returns the whole { data, meta } envelope when envelope is true', async () => {
    const envelope = { data: [{ id: 11 }], meta: { nextCursor: 'eyJpZCI6MTF9', hasMore: true } };
    fetchMock.mockResolvedValue(jsonResponse(envelope));

    await expect(apiRequest('/subscribers/7/records', { envelope: true })).resolves.toEqual(
      envelope,
    );
  });

  it('returns the raw body when bare is true — the register/login exception', async () => {
    const auth = { accessToken: 'jwt-1', tokenType: 'Bearer', user: { id: 1, email: 'a@b.c' } };
    fetchMock.mockResolvedValue(jsonResponse(auth));

    await expect(
      apiRequest('/auth/register', {
        method: 'POST',
        body: { email: 'a@b.c', password: 'pw' },
        bare: true,
      }),
    ).resolves.toEqual(auth);
  });

  it('serializes the body as JSON and sets Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 2 } }));

    await apiRequest('/workspaces', { method: 'POST', body: { name: 'Acme' } });

    const { url, init } = lastFetch();
    expect(url).toBe('/api/workspaces');
    expect(init.method).toBe('POST');
    expect(lastHeaders().get('Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'Acme' }));
  });

  it('attaches the stored token as a Bearer Authorization header', async () => {
    setToken('jwt-test-token');
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await apiRequest('/workspaces');

    expect(lastHeaders().get('Authorization')).toBe('Bearer jwt-test-token');
  });

  it('omits Authorization and Content-Type headers when there is no token and no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await apiRequest('/workspaces');

    const headers = lastHeaders();
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBeNull();
  });

  it('maps the error envelope onto ApiError status, code, message, requestId and details', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'invalid_destination',
            message: 'destinationUrl must be a valid https URL',
            details: { field: 'destinationUrl' },
            requestId: 'req-4f8a2c',
          },
        },
        422,
      ),
    );

    const error = await captureRejection(() => apiRequest('/workspaces'));

    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(422);
    expect(error.code).toBe('invalid_destination');
    expect(error.message).toBe('destinationUrl must be a valid https URL');
    expect(error.requestId).toBe('req-4f8a2c');
    expect(error.details).toEqual({ field: 'destinationUrl' });
  });

  it('falls back to unknown_error and the status message when the body carries no envelope', async () => {
    fetchMock.mockResolvedValue(rawResponse('<html>Bad Gateway</html>', 502));

    const error = await captureRejection(() => apiRequest('/workspaces'));

    expect(error.status).toBe(502);
    expect(error.code).toBe('unknown_error');
    expect(error.message).toBe('Request failed with status 502');
  });

  it('keeps a known error code but falls back on a missing message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'rate_limited' } }, 429));

    const error = await captureRejection(() => apiRequest('/workspaces'));

    expect(error.status).toBe(429);
    expect(error.code).toBe('rate_limited');
    expect(error.message).toBe('Request failed with status 429');
  });

  it('maps a fetch rejection to ApiError status 0 / network_error with the cause kept', async () => {
    const cause = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValueOnce(cause);

    const error = await captureRejection(() => apiRequest('/workspaces'));

    expect(error.status).toBe(0);
    expect(error.code).toBe('network_error');
    expect(error.message).toBe('Cannot reach the HookLab API');
    expect(error.cause).toBe(cause);
  });

  it('rejects with invalid_response when a success body has no data field', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ subscribed: true }));

    const error = await captureRejection(() => apiRequest('/workspaces'));

    expect(error.status).toBe(200);
    expect(error.code).toBe('invalid_response');
    expect(error.message).toBe('API response is missing its data field');
  });

  it('resolves to undefined for a 204 No Content response', async () => {
    fetchMock.mockResolvedValue(rawResponse('', 204));

    await expect(apiRequest('/subscribers/4', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('calls the registered unauthorized handler and rejects on 401', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'unauthorized', message: 'Token expired' } }, 401),
    );

    const error = await captureRejection(() => apiRequest('/workspaces'));

    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthorized');
    expect(error.message).toBe('Token expired');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
