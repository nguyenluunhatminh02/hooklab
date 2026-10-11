import { getToken } from '../auth/tokenStorage';

const API_PREFIX = '/api';
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
const HTTP_NO_CONTENT = 204;

/**
 * API error with the 02 §1.2 envelope attached. `status === 0` means the
 * request never reached the server (offline / DNS / connection refused).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

interface ErrorEnvelope {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  requestId?: unknown;
}

function toApiError(status: number, payload: unknown, fallbackMessage: string): ApiError {
  const envelope =
    typeof payload === 'object' && payload !== null
      ? ((payload as { error?: ErrorEnvelope }).error ?? undefined)
      : undefined;
  if (typeof envelope !== 'object' || envelope === null) {
    return new ApiError(status, 'unknown_error', fallbackMessage);
  }
  return new ApiError(
    status,
    typeof envelope.code === 'string' ? envelope.code : 'unknown_error',
    typeof envelope.message === 'string' ? envelope.message : fallbackMessage,
    {
      details: envelope.details,
      requestId: typeof envelope.requestId === 'string' ? envelope.requestId : undefined,
    },
  );
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registered by AuthStore: any 401 clears the session and returns the user to
 * `/login?next=…` (04 §5 step 7). One interception point, never per-call.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * register/login are the sole bare-body routes (02 §1.2 exception) — every
   * other response is the `{ data }` envelope.
   */
  bare?: boolean;
  /**
   * List routes attach `meta` next to `data` (02 §1.2) — unwrap would drop the
   * cursor. Return the whole `{ data, meta }` envelope instead.
   */
  envelope?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, bare = false, envelope = false } = options;
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiError(0, 'network_error', 'Cannot reach the HookLab API', { cause });
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw !== '') {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = null;
    }
  }

  if (response.status === HTTP_UNAUTHORIZED) {
    unauthorizedHandler?.();
    throw toApiError(response.status, payload, 'Session expired — sign in again');
  }

  if (!response.ok) {
    throw toApiError(response.status, payload, `Request failed with status ${response.status}`);
  }

  if (response.status === HTTP_NO_CONTENT) return undefined as unknown as T;
  if (bare || envelope) return payload as T;

  const data =
    typeof payload === 'object' && payload !== null
      ? (payload as { data?: T }).data
      : undefined;
  if (data === undefined) {
    throw new ApiError(response.status, 'invalid_response', 'API response is missing its data field');
  }
  return data;
}
