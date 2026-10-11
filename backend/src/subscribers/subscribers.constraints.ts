import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { MAX_DESTINATION_HEADERS } from '../common/constants/app.constants';
import {
  DESTINATION_AUTH_TYPES,
  DESTINATION_AUTH_VALUE_FORBIDDEN_PATTERN,
  DESTINATION_HEADER_NAME_MAX_LENGTH,
  DESTINATION_HEADER_NAME_PATTERN,
  DESTINATION_HEADER_VALUE_FORBIDDEN_PATTERN,
  DESTINATION_HEADER_VALUE_MAX_LENGTH,
} from './subscribers.constants';

/**
 * Destination URL gate (02 §4, BUILD_PLAN §7 P2): http/https only, no
 * embedded credentials, must parse as an absolute URL. One WHATWG parse
 * answers all four rejection cases at once — `file://`/`ftp://` fail the
 * protocol check, scheme-less strings throw on parse, `http://user:pass@host`
 * is caught by the userinfo check (class-validator's @IsUrl alone accepts it).
 * IP/SSRF policy is deliberately NOT applied here: replay re-validates
 * resolved addresses at send time (02 §4/§6).
 */
export function isSafeDestinationUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  return parsed.hostname !== '';
}

@ValidatorConstraint({ name: 'isDestinationUrl', async: false })
export class IsDestinationUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isSafeDestinationUrl(value);
  }

  defaultMessage(): string {
    return 'destinationUrl must be an absolute http(s) URL with no embedded credentials';
  }
}

/**
 * Destination headers (audit H-1): the record shape cannot carry per-key
 * class-validator decorators, so one constraint enforces the whole contract —
 * entry cap, RFC 7230 token names (CR/LF impossible), per-value string +
 * length, and values fetch can actually carry (C0 controls other than an
 * interior HTAB, DEL, and anything above Latin-1 make the outbound leg throw
 * at replay — a mislabeled transport error instead of a write-time 400).
 */
@ValidatorConstraint({ name: 'isDestinationHeaders', async: false })
export class IsDestinationHeadersConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_DESTINATION_HEADERS) {
      return false;
    }
    return entries.every(
      ([name, headerValue]) =>
        name.length <= DESTINATION_HEADER_NAME_MAX_LENGTH &&
        DESTINATION_HEADER_NAME_PATTERN.test(name) &&
        typeof headerValue === 'string' &&
        headerValue.length <= DESTINATION_HEADER_VALUE_MAX_LENGTH &&
        !DESTINATION_HEADER_VALUE_FORBIDDEN_PATTERN.test(headerValue),
    );
  }

  defaultMessage(): string {
    return (
      `destinationHeaders allows at most ${MAX_DESTINATION_HEADERS} entries; ` +
      `names must be HTTP header tokens (≤ ${DESTINATION_HEADER_NAME_MAX_LENGTH} chars, no CR/LF); ` +
      `values must be single-line strings of ≤ ${DESTINATION_HEADER_VALUE_MAX_LENGTH} chars ` +
      'fetch can carry (no other control bytes, nothing above Latin-1)'
    );
  }
}

const AUTH_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  bearer: ['token'],
  basic: ['username', 'password'],
  apiKey: ['headerName', 'value'],
};

function isAuthCredentialField(value: unknown, maxLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !DESTINATION_AUTH_VALUE_FORBIDDEN_PATTERN.test(value)
  );
}

/**
 * Outbound auth gate (02 §4): one constraint over the whole record because the
 * required fields depend on `type`. `{ type: 'none' }` is the explicit clear
 * marker — it carries no credential fields, and any extra key is rejected so a
 * caller cannot smuggle a credential under a type that ignores it. Every
 * accepted string is one non-empty visible line ≤ the destination-header value
 * cap; the replay leg normalizes leading/trailing OWS to the wire spelling
 * before sending (safeHeader), so what it emits stays within this contract.
 */
@ValidatorConstraint({ name: 'isDestinationAuth', async: false })
export class IsDestinationAuthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const { type } = record;
    if (typeof type !== 'string' || !(DESTINATION_AUTH_TYPES as readonly string[]).includes(type)) {
      return false;
    }
    // Exact key set per type — `type` itself plus the fields that type
    // requires ('none' requires nothing). Counting only the credential fields
    // would reject every valid record, which always carries `type`.
    const credentialFields = AUTH_REQUIRED_FIELDS[type];
    const requiredKeys = credentialFields === undefined ? ['type'] : ['type', ...credentialFields];
    const keys = Object.keys(record);
    if (keys.length !== requiredKeys.length) {
      return false;
    }
    if (!requiredKeys.every((key) => keys.includes(key))) {
      return false;
    }
    if (credentialFields === undefined) {
      return true;
    }
    if (type === 'apiKey') {
      const headerName = record.headerName;
      if (
        typeof headerName !== 'string' ||
        headerName.length > DESTINATION_HEADER_NAME_MAX_LENGTH ||
        !DESTINATION_HEADER_NAME_PATTERN.test(headerName)
      ) {
        return false;
      }
      return isAuthCredentialField(record.value, DESTINATION_HEADER_VALUE_MAX_LENGTH);
    }
    return credentialFields.every((field) =>
      isAuthCredentialField(record[field], DESTINATION_HEADER_VALUE_MAX_LENGTH),
    );
  }

  defaultMessage(): string {
    return (
      "destinationAuth must be { type: 'none' } or carry exactly the fields its type requires " +
      "(bearer: token; basic: username, password; apiKey: headerName, value); " +
      `credentials are single-line strings of 1–${DESTINATION_HEADER_VALUE_MAX_LENGTH} chars ` +
      'and apiKey headerName must be an HTTP header token'
    );
  }
}
