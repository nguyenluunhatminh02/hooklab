import { describe, expect, it } from 'vitest';
import { describeStoredAuth } from './destinationAuth';

/**
 * Detail-line fragments (02 §4): the page renders a credential as a short
 * fragment carrying only the masked hint, never a secret.
 */

describe('describeStoredAuth', () => {
  it('renders none as a bare word', () => {
    expect(describeStoredAuth({ type: 'none' })).toBe('none');
  });

  it('renders each credential type with its hint', () => {
    expect(describeStoredAuth({ type: 'bearer', tokenHint: '…cdef' })).toBe(
      'Bearer (token ends …cdef)',
    );
    expect(describeStoredAuth({ type: 'basic', usernameHint: '…prod' })).toBe(
      'Basic (username ends …prod)',
    );
    expect(describeStoredAuth({ type: 'apiKey', headerName: 'X-Key', valueHint: '…9876' })).toBe(
      'X-Key (value ends …9876)',
    );
  });
});