import { useState, type FormEvent } from 'react';
import type {
  DestinationAuthInput,
  DestinationAuthMasked,
  DestinationMethod,
  SubscriberDetail,
} from '../api/types';
import { describeStoredAuth } from '../lib/destinationAuth';

export interface SubscriberFormValues {
  name: string;
  destinationUrl: string;
  destinationMethod: DestinationMethod;
  destinationHeaders: Record<string, string>;
  /** Omitted when blank — the DTO's @Matches rejects '' (only null/undefined skip validation). */
  signatureHeader?: string;
  /**
   * Omitted when the credential fields are all blank — on edit that means
   * "keep the stored credential", so a half-filled form can never wipe it.
   * A clear is explicit: `{ type: 'none' }`.
   */
  destinationAuth?: DestinationAuthInput;
}

interface SubscriberFormProps {
  /** Pre-filled from a detail payload turns the form into edit mode. */
  initial?: SubscriberDetail;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (values: SubscriberFormValues) => void;
  onCancel?: () => void;
}

type FieldErrors = Partial<
  Record<
    | 'name'
    | 'destinationUrl'
    | 'signatureHeader'
    | 'headersText'
    | 'authToken'
    | 'authUsername'
    | 'authPassword'
    | 'authHeaderName'
    | 'authValue',
    string
  >
>;

/** Client-side mirrors of the 02 §4 DTO caps (subscribers.constants). */
const METHODS: DestinationMethod[] = ['POST', 'PUT', 'PATCH'];
const SIGNATURE_HEADER_PATTERN = /^[\w-]{1,64}$/;
const MAX_NAME_LENGTH = 80;
// RFC 7230 field-name token — mirrors DESTINATION_HEADER_NAME_PATTERN (02 §4),
// which is deliberately wider than \w: header names like X-Webhook-Key! are
// valid HTTP tokens even when unusual.
const AUTH_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const AUTH_VALUE_MAX_LENGTH = 4096;
const AUTH_VALUE_FORBIDDEN_PATTERN = /[\u0000-\u001F\u007F]/;

function parseHeaders(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

/** Mirrors IsDestinationAuthConstraint: one visible line, bounded in length. */
function isSingleLineBounded(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= AUTH_VALUE_MAX_LENGTH &&
    !AUTH_VALUE_FORBIDDEN_PATTERN.test(value)
  );
}

/**
 * The stored credential as the API reads it back (02 §4) — always masked, so
 * it is safe to render into the edit form's hint line.
 */
function maskedAuthOf(initial: SubscriberDetail | undefined): DestinationAuthMasked {
  return initial?.destination.auth ?? { type: 'none' };
}

/**
 * Field placeholder: when a credential of the matching type is stored, the
 * empty input shows its masked hint (the secret itself never reaches the
 * client); otherwise it shows what to type.
 */
function credentialPlaceholder(
  stored: DestinationAuthMasked,
  kind: 'token' | 'username' | 'password' | 'headerName' | 'value',
): string {
  switch (kind) {
    case 'token':
      return stored.type === 'bearer' ? `stored: ${stored.tokenHint}` : 'paste the token';
    case 'username':
      return stored.type === 'basic' ? `stored: ${stored.usernameHint}` : 'username';
    case 'password':
      return stored.type === 'basic' ? 'leave blank to keep' : 'password';
    case 'headerName':
      return stored.type === 'apiKey' ? stored.headerName : 'X-Api-Key';
    case 'value':
      return stored.type === 'apiKey' ? `stored: ${stored.valueHint}` : 'paste the key';
  }
}

/**
 * Client-side mirror of the 02 §4 DTO rules — the server still validates
 * (whitelist + forbidNonWhitelisted), this only avoids a round trip for
 * obvious mistakes.
 */
export function SubscriberForm({
  initial,
  submitLabel,
  submitting = false,
  onSubmit,
  onCancel,
}: SubscriberFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [destinationUrl, setDestinationUrl] = useState(initial?.destination.url ?? '');
  const [destinationMethod, setDestinationMethod] = useState<DestinationMethod>(
    initial?.destination.method ?? 'POST',
  );
  const [headersText, setHeadersText] = useState(
    initial ? JSON.stringify(initial.destination.headers, null, 2) : '{}',
  );
  const [signatureHeader, setSignatureHeader] = useState(initial?.signatureHeader ?? '');

  // Destination auth: the selected type starts from the stored credential (or
  // 'none' for a fresh create); the credential inputs start blank so a save
  // with everything blank sends no destinationAuth key at all — on edit the
  // stored credential survives, on create the subscriber has none.
  const storedAuth = maskedAuthOf(initial);
  const [authType, setAuthType] = useState<DestinationAuthInput['type']>(storedAuth.type);
  const [authToken, setAuthToken] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authHeaderName, setAuthHeaderName] = useState('');
  const [authValue, setAuthValue] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const nextErrors: FieldErrors = {};
    if (name.trim() === '') {
      nextErrors.name = 'Name is required.';
    } else if (name.trim().length > MAX_NAME_LENGTH) {
      nextErrors.name = `Name must be at most ${MAX_NAME_LENGTH} characters.`;
    }

    try {
      const url = new URL(destinationUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        nextErrors.destinationUrl = 'Destination must be an http:// or https:// URL.';
      }
    } catch {
      nextErrors.destinationUrl = 'Destination must be a valid http:// or https:// URL.';
    }

    const parsedHeaders = parseHeaders(headersText);
    if (parsedHeaders === null) {
      nextErrors.headersText = 'Headers must be a JSON object of string values, e.g. {"X-Api-Key": "…"}';
    }

    if (signatureHeader !== '' && !SIGNATURE_HEADER_PATTERN.test(signatureHeader)) {
      nextErrors.signatureHeader = 'Header name may only contain letters, digits, "-" and "_".';
    }

    if (authType === 'bearer' && !isBlank(authToken) && !isSingleLineBounded(authToken)) {
      nextErrors.authToken = `Token must be 1–${AUTH_VALUE_MAX_LENGTH} characters of one line.`;
    }
    if (authType === 'basic') {
      const usernameTouched = !isBlank(authUsername);
      const passwordTouched = authPassword !== '';
      // A credential pair is all-or-nothing: half a pair would be dropped on
      // submit (blank = "keep stored"), so saying so upfront beats a silent keep.
      if (usernameTouched !== passwordTouched) {
        nextErrors.authUsername = 'Both username and password are required.';
      }
      if (usernameTouched && !isSingleLineBounded(authUsername)) {
        nextErrors.authUsername = `Username must be 1–${AUTH_VALUE_MAX_LENGTH} characters of one line.`;
      }
      if (passwordTouched && !isSingleLineBounded(authPassword)) {
        nextErrors.authPassword = `Password must be 1–${AUTH_VALUE_MAX_LENGTH} characters of one line.`;
      }
    }
    if (authType === 'apiKey') {
      const nameTouched = !isBlank(authHeaderName);
      const valueTouched = !isBlank(authValue);
      if (nameTouched !== valueTouched) {
        nextErrors.authHeaderName = 'Both header name and value are required.';
      }
      if (nameTouched && !AUTH_TOKEN_PATTERN.test(authHeaderName)) {
        nextErrors.authHeaderName =
          'Header name must be an HTTP header token (letters, digits and RFC 7230 punctuation).';
      }
      if (valueTouched && !isSingleLineBounded(authValue)) {
        nextErrors.authValue = `Value must be 1–${AUTH_VALUE_MAX_LENGTH} characters of one line.`;
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const values: SubscriberFormValues = {
      name: name.trim(),
      destinationUrl,
      destinationMethod,
      destinationHeaders: parsedHeaders ?? {},
    };
    // Blank must omit the key entirely: the server's @Matches rejects '' and
    // @IsOptional only skips null/undefined, so sending it is a 400.
    if (signatureHeader !== '') {
      values.signatureHeader = signatureHeader;
    }

    // The auth key is only sent when the form actually carries a credential:
    // a blank selection means "keep the stored one" in edit mode, so a clear
    // must be the explicit { type: 'none' } below.
    if (authType === 'bearer' && authToken.trim() !== '') {
      values.destinationAuth = { type: 'bearer', token: authToken.trim() };
    } else if (authType === 'basic' && (authUsername.trim() !== '' || authPassword !== '')) {
      values.destinationAuth = {
        type: 'basic',
        username: authUsername.trim(),
        password: authPassword,
      };
    } else if (authType === 'apiKey' && authHeaderName.trim() !== '' && authValue.trim() !== '') {
      values.destinationAuth = {
        type: 'apiKey',
        headerName: authHeaderName.trim(),
        value: authValue.trim(),
      };
    } else if (authType === 'none') {
      // Explicitly selected "No authentication" — on edit this clears the
      // stored credential server-side via { type: 'none' }.
      values.destinationAuth = { type: 'none' };
    }
    onSubmit(values);
  }

  return (
    <form className="subscriber-form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="subscriber-name">Name</label>
        <input
          id="subscriber-name"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          required
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'subscriber-name-error' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {errors.name ? (
          <p id="subscriber-name-error" role="alert" className="field-error">
            {errors.name}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="subscriber-url">Destination URL</label>
        <input
          id="subscriber-url"
          type="url"
          value={destinationUrl}
          required
          placeholder="https://example.com/hooks/stripe"
          aria-invalid={errors.destinationUrl ? true : undefined}
          aria-describedby={errors.destinationUrl ? 'subscriber-url-error' : undefined}
          onChange={(event) => setDestinationUrl(event.target.value)}
        />
        {errors.destinationUrl ? (
          <p id="subscriber-url-error" role="alert" className="field-error">
            {errors.destinationUrl}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="subscriber-method">Destination method</label>
          <select
            id="subscriber-method"
            value={destinationMethod}
            onChange={(event) => setDestinationMethod(event.target.value as DestinationMethod)}
          >
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="subscriber-signature-header">Signature header (optional)</label>
          <input
            id="subscriber-signature-header"
            value={signatureHeader}
            placeholder="X-Hub-Signature-256"
            aria-invalid={errors.signatureHeader ? true : undefined}
            aria-describedby={
              errors.signatureHeader ? 'subscriber-signature-header-error' : undefined
            }
            onChange={(event) => setSignatureHeader(event.target.value)}
          />
          {errors.signatureHeader ? (
            <p id="subscriber-signature-header-error" role="alert" className="field-error">
              {errors.signatureHeader}
            </p>
          ) : null}
        </div>
      </div>

      <div className="field">
        <label htmlFor="subscriber-headers">Destination headers (JSON object)</label>
        <textarea
          id="subscriber-headers"
          className="mono"
          rows={4}
          value={headersText}
          aria-invalid={errors.headersText ? true : undefined}
          aria-describedby={
            errors.headersText ? 'subscriber-headers-error' : 'subscriber-headers-hint'
          }
          onChange={(event) => setHeadersText(event.target.value)}
        />
        <p id="subscriber-headers-hint" className="hint">
          Forwarded on every replay and forwarded delivery, e.g. {"{\"X-Api-Key\": \"…}\"}"}
        </p>
        {errors.headersText ? (
          <p id="subscriber-headers-error" role="alert" className="field-error">
            {errors.headersText}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="subscriber-auth-type">Destination authentication</label>
        <select
          id="subscriber-auth-type"
          value={authType}
          onChange={(event) => {
            setAuthType(event.target.value as DestinationAuthInput['type']);
            // The credential fields belong to the selected type alone: left
            // uncleared, a token typed under bearer would silently re-enter the
            // payload after a switch to another type and back (02 §4 keep-blank
            // semantics would resubmit the stale secret).
            setAuthToken('');
            setAuthUsername('');
            setAuthPassword('');
            setAuthHeaderName('');
            setAuthValue('');
          }}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (username + password)</option>
          <option value="apiKey">API key (custom header)</option>
        </select>
        {storedAuth.type !== 'none' ? (
          <p className="hint">Stored: {describeStoredAuth(storedAuth)}</p>
        ) : null}
        {authType !== 'none' ? (
          <p id="subscriber-auth-hint" className="hint">
            Sent as an outbound header on every delivery and replay. Empty fields keep the stored
            credential; pick None and save to remove it.
          </p>
        ) : null}
        {authType === 'bearer' ? (
          <label htmlFor="subscriber-auth-token">
            Token
            <input
              id="subscriber-auth-token"
              type="password"
              autoComplete="new-password"
              value={authToken}
              placeholder={credentialPlaceholder(storedAuth, 'token')}
              aria-invalid={errors.authToken ? true : undefined}
              aria-describedby={errors.authToken ? 'subscriber-auth-token-error' : undefined}
              onChange={(event) => setAuthToken(event.target.value)}
            />
            {errors.authToken ? (
              <span id="subscriber-auth-token-error" role="alert" className="field-error">
                {errors.authToken}
              </span>
            ) : null}
          </label>
        ) : null}
        {authType === 'basic' ? (
          <>
            <label htmlFor="subscriber-auth-username">
              Username
              <input
                id="subscriber-auth-username"
                autoComplete="username"
                value={authUsername}
                placeholder={credentialPlaceholder(storedAuth, 'username')}
                aria-invalid={errors.authUsername ? true : undefined}
                aria-describedby={
                  errors.authUsername ? 'subscriber-auth-username-error' : undefined
                }
                onChange={(event) => setAuthUsername(event.target.value)}
              />
              {errors.authUsername ? (
                <span id="subscriber-auth-username-error" role="alert" className="field-error">
                  {errors.authUsername}
                </span>
              ) : null}
            </label>
            <label htmlFor="subscriber-auth-password">
              Password
              <input
                id="subscriber-auth-password"
                type="password"
                autoComplete="new-password"
                value={authPassword}
                placeholder="leave blank to keep"
                aria-invalid={errors.authPassword ? true : undefined}
                aria-describedby={
                  errors.authPassword ? 'subscriber-auth-password-error' : undefined
                }
                onChange={(event) => setAuthPassword(event.target.value)}
              />
              {errors.authPassword ? (
                <span id="subscriber-auth-password-error" role="alert" className="field-error">
                  {errors.authPassword}
                </span>
              ) : null}
            </label>
          </>
        ) : null}
        {authType === 'apiKey' ? (
          <>
            <label htmlFor="subscriber-auth-header-name">
              Header name
              <input
                id="subscriber-auth-header-name"
                value={authHeaderName}
                placeholder={credentialPlaceholder(storedAuth, 'headerName')}
                aria-invalid={errors.authHeaderName ? true : undefined}
                aria-describedby={
                  errors.authHeaderName ? 'subscriber-auth-header-name-error' : undefined
                }
                onChange={(event) => setAuthHeaderName(event.target.value)}
              />
              {errors.authHeaderName ? (
                <span id="subscriber-auth-header-name-error" role="alert" className="field-error">
                  {errors.authHeaderName}
                </span>
              ) : null}
            </label>
            <label htmlFor="subscriber-auth-value">
              Value
              <input
                id="subscriber-auth-value"
                type="password"
                autoComplete="new-password"
                value={authValue}
                placeholder={credentialPlaceholder(storedAuth, 'value')}
                aria-invalid={errors.authValue ? true : undefined}
                aria-describedby={errors.authValue ? 'subscriber-auth-value-error' : undefined}
                onChange={(event) => setAuthValue(event.target.value)}
              />
              {errors.authValue ? (
                <span id="subscriber-auth-value-error" role="alert" className="field-error">
                  {errors.authValue}
                </span>
              ) : null}
            </label>
          </>
        ) : null}
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}