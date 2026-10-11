import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTHED_PATH, sanitizeNextPath } from './nextPath';

describe('sanitizeNextPath', () => {
  it('keeps in-app paths including query and hash', () => {
    expect(sanitizeNextPath('/w/1/subscribers?status=verified#top')).toBe(
      '/w/1/subscribers?status=verified#top',
    );
  });

  it('rejects empty input', () => {
    expect(sanitizeNextPath(null)).toBe(DEFAULT_AUTHED_PATH);
    expect(sanitizeNextPath('')).toBe(DEFAULT_AUTHED_PATH);
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(sanitizeNextPath('//evil.com')).toBe(DEFAULT_AUTHED_PATH);
    expect(sanitizeNextPath('https://evil.com/steal')).toBe(DEFAULT_AUTHED_PATH);
    expect(sanitizeNextPath('javascript:alert(1)')).toBe(DEFAULT_AUTHED_PATH);
  });

  // Regression: `new URL('/\\evil.com', origin)` resolves off-origin, and
  // React Router's history falls back to location.assign on the resulting
  // SecurityError — so backslash paths must never pass the guard.
  it('rejects backslash-prefixed paths that resolve off-origin', () => {
    expect(sanitizeNextPath('/\\evil.com')).toBe(DEFAULT_AUTHED_PATH);
    expect(sanitizeNextPath('/\\evil.com/path')).toBe(DEFAULT_AUTHED_PATH);
    expect(sanitizeNextPath('\\/evil.com')).toBe(DEFAULT_AUTHED_PATH);
  });
});
