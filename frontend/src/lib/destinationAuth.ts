import type { DestinationAuthMasked } from '../api/types';

/**
 * One human-readable fragment for a stored destination credential (02 §4) —
 * shared by the detail page's summary line and the edit form's stored-credential
 * hint. Only masked hints ever reach these renderers, so the fragment can carry
 * them safely: "Bearer (token ends …cdef)", "X-Key (value ends …9876)".
 */
export function describeStoredAuth(auth: DestinationAuthMasked): string {
  switch (auth.type) {
    case 'none':
      return 'none';
    case 'bearer':
      return `Bearer (token ends ${auth.tokenHint})`;
    case 'basic':
      return `Basic (username ends ${auth.usernameHint})`;
    case 'apiKey':
      return `${auth.headerName} (value ends ${auth.valueHint})`;
  }
}