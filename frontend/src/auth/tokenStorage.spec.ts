import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_STORAGE_KEY, clearToken, getToken, setToken } from './tokenStorage';

describe('tokenStorage', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('exposes hooklab.token as the storage key', () => {
    expect(TOKEN_STORAGE_KEY).toBe('hooklab.token');
  });

  it('returns null when nothing has been stored', () => {
    expect(getToken()).toBeNull();
  });

  it('round-trips a token through setToken and getToken', () => {
    setToken('jwt-round-trip');

    expect(getToken()).toBe('jwt-round-trip');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('jwt-round-trip');
  });

  it('removes the token on clearToken', () => {
    setToken('jwt-round-trip');

    clearToken();

    expect(getToken()).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
