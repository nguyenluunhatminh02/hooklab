import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubscriberForm, type SubscriberFormValues } from './SubscriberForm';
import type { SubscriberDetail } from '../api/types';

/**
 * Form contract (02 §4): client-side mirror of the server DTO rules. The
 * assertions here pin the exact shape handed to `onSubmit` — the page passes
 * it straight into the create/update mutations, so a drift would surface at
 * the API boundary, not at the input.
 */

const initial: SubscriberDetail = {
  id: 7,
  workspaceId: 1,
  name: 'payments',
  status: 'active',
  endpointUrl: 'https://example.com/ingest/tok',
  ingestToken: 'tok',
  destination: { method: 'POST', url: 'https://example.com/hook', headers: { 'X-Api-Key': 'k' }, auth: { type: 'none' } },
  signatureHeader: 'x-hooklab-signature',
  receivedCount: 2,
  verifiedCount: 1,
  rejectedCount: 1,
  createdAt: '2026-10-08T00:00:00.000Z',
  revokedAt: null,
  secretHint: '...abc',
};

/** Braces/brackets are key descriptors in userEvent.type — set JSON via change. */
function setHeaders(text: string): HTMLTextAreaElement {
  const textarea = screen.getByLabelText('Destination headers (JSON object)') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  return textarea;
}

describe('SubscriberForm', () => {
  it('renders the blank create form and reports empty required fields on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Destination must be a valid http:// or https:// URL.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    // The name field carries the invalid state plus a described-by link to its alert.
    const nameInput = screen.getByLabelText('Name');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    const errorId = nameInput.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')).toHaveTextContent('Name is required.');
  });

  it('rejects a name over 80 characters and a URL on a non-http scheme', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    // Programmatic change: the maxLength attribute only constrains typing, while
    // the over-length guard in handleSubmit must still hold for pasted values.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x'.repeat(81) } });
    await user.type(screen.getByLabelText('Destination URL'), 'ftp://example.com/hook');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(screen.getByText('Name must be at most 80 characters.')).toBeInTheDocument();
    expect(screen.getByText('Destination must be an http:// or https:// URL.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // A blank signature field must OMIT the key, not send '': the DTO pairs
  // @IsOptional with @Matches, and class-validator only skips null/undefined —
  // an empty string is a 400 on the real create route (verified empirically).
  it('submits the create payload with default method, empty headers and no signatureHeader key', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Stripe',
      destinationUrl: 'https://example.com/hooks/stripe',
      destinationMethod: 'POST',
      destinationHeaders: {},
      // Explicit "no auth" selection — the server maps it to a null column.
      destinationAuth: { type: 'none' },
    } satisfies SubscriberFormValues);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('signatureHeader');
  });

  it('pre-fills edit mode from the detail payload and submits those exact values', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm initial={initial} submitLabel="Save changes" onSubmit={onSubmit} />);

    expect(screen.getByLabelText('Name')).toHaveValue('payments');
    expect(screen.getByLabelText('Destination URL')).toHaveValue('https://example.com/hook');
    expect(screen.getByLabelText('Destination method')).toHaveValue('POST');
    expect(screen.getByLabelText('Signature header (optional)')).toHaveValue('x-hooklab-signature');
    expect(screen.getByLabelText('Destination headers (JSON object)')).toHaveValue(
      '{\n  "X-Api-Key": "k"\n}',
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'payments',
      destinationUrl: 'https://example.com/hook',
      destinationMethod: 'POST',
      destinationHeaders: { 'X-Api-Key': 'k' },
      signatureHeader: 'x-hooklab-signature',
      destinationAuth: { type: 'none' },
    } satisfies SubscriberFormValues);
  });

  it('submits a selected destination method and custom headers parsed from the JSON textarea', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination method'), 'PATCH');
    setHeaders('{"X-Api-Key": "abc", "X-Signature": "sha256=x"}');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Stripe',
      destinationUrl: 'https://example.com/hooks/stripe',
      destinationMethod: 'PATCH',
      destinationHeaders: { 'X-Api-Key': 'abc', 'X-Signature': 'sha256=x' },
      destinationAuth: { type: 'none' },
    } satisfies SubscriberFormValues);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('signatureHeader');
  });

  it('rejects header JSON whose values are not strings', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    setHeaders('{"X-Api-Key": 42}');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(
      screen.getByText('Headers must be a JSON object of string values, e.g. {"X-Api-Key": "…"}'),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears a stale header error once the textarea holds a valid object', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    const textarea = setHeaders('not json');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));
    expect(screen.getByText('Headers must be a JSON object of string values, e.g. {"X-Api-Key": "…"}'))
      .toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: '{"ok": "true"}' } });
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(screen.queryByText(/Headers must be a JSON object/)).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ destinationHeaders: { ok: 'true' } }),
    );
  });

  it('rejects a signature header with characters outside letters, digits, "-" and "_"', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.type(screen.getByLabelText('Signature header (optional)'), 'X-Bad Header!');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(
      screen.getByText('Header name may only contain letters, digits, "-" and "_".'),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the submit button and shows the saving label while submitting', () => {
    render(<SubscriberForm submitLabel="Create subscriber" submitting onSubmit={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('renders the cancel button only when onCancel is provided and fires it', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    const { unmount } = render(
      <SubscriberForm submitLabel="Save changes" onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  // --- destination authentication (02 §4) ---------------------------------

  it('submits a bearer credential once a token is entered', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'bearer');
    await user.type(screen.getByLabelText('Token'), 'tok_live_abc123');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ destinationAuth: { type: 'bearer', token: 'tok_live_abc123' } }),
    );
  });

  it('submits an API-key credential with its custom header name', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'apiKey');
    await user.type(screen.getByLabelText('Header name'), 'X-Api-Key');
    await user.type(screen.getByLabelText('Value'), 'key_9876');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationAuth: { type: 'apiKey', headerName: 'X-Api-Key', value: 'key_9876' },
      }),
    );
  });

  it('keeps the stored credential when its fields stay blank on edit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const withBearer: SubscriberDetail = {
      ...initial,
      destination: { ...initial.destination, auth: { type: 'bearer', tokenHint: '…cdef' } },
    };

    render(<SubscriberForm initial={withBearer} submitLabel="Save changes" onSubmit={onSubmit} />);

    // The masked hint is offered as a placeholder; the input itself stays empty
    // so a save cannot accidentally submit the hint as a real token.
    expect(screen.getByLabelText('Token')).toHaveAttribute('placeholder', 'stored: …cdef');
    expect(screen.getByLabelText('Token')).toHaveValue('');
    expect(screen.getByText('Stored: Bearer (token ends …cdef)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // No destinationAuth key at all = PATCH keeps the stored credential.
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('destinationAuth');
  });

  it('accepts an apiKey header name that is a valid RFC 7230 token with punctuation', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'apiKey');
    // '.' and '!' are legitimate HTTP field-name tokens — the DTO gate accepts
    // them, so the client mirror must not reject them (02 §4 DESTINATION_HEADER_NAME_PATTERN).
    await user.type(screen.getByLabelText('Header name'), 'X-Webhook.Key!');
    await user.type(screen.getByLabelText('Value'), 'key_9876');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationAuth: { type: 'apiKey', headerName: 'X-Webhook.Key!', value: 'key_9876' },
      }),
    );
  });

  it('keeps the stored apiKey credential when its fields stay blank on edit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const withApiKey: SubscriberDetail = {
      ...initial,
      destination: {
        ...initial.destination,
        headers: {},
        auth: { type: 'apiKey', headerName: 'X-Webhook-Key', valueHint: '…9012' },
      },
    };

    render(<SubscriberForm initial={withApiKey} submitLabel="Save changes" onSubmit={onSubmit} />);

    // The stored apiKey header name is offered as a placeholder, never pre-filled
    // into the input: the header value is masked (only …last4), so pre-filling
    // the name would leave a half pair the form would have to reject.
    expect(screen.getByLabelText('Header name')).toHaveAttribute('placeholder', 'X-Webhook-Key');
    expect(screen.getByLabelText('Header name')).toHaveValue('');
    expect(screen.getByLabelText('Value')).toHaveValue('');
    expect(screen.getByText('Stored: X-Webhook-Key (value ends …9012)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // No destinationAuth key at all = PATCH keeps the stored credential.
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('destinationAuth');
  });

  it('clears previously typed credential fields when the auth type is switched', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'bearer');
    await user.type(screen.getByLabelText('Token'), 'tok_abc');

    // Switch away and back: the token typed under bearer must not reappear —
    // otherwise a later save under bearer would silently resubmit it as a
    // credential change when the user only switched types.
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'apiKey');
    expect(screen.getByLabelText('Header name')).toHaveValue('');
    expect(screen.getByLabelText('Value')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'bearer');
    expect(screen.getByLabelText('Token')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Blank bearer fields on a fresh create = no destinationAuth key.
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('destinationAuth');
  });

  it('clears the stored credential only when None is explicitly selected', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const withBearer: SubscriberDetail = {
      ...initial,
      destination: { ...initial.destination, auth: { type: 'bearer', tokenHint: '…cdef' } },
    };

    render(<SubscriberForm initial={withBearer} submitLabel="Save changes" onSubmit={onSubmit} />);
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'none');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ destinationAuth: { type: 'none' } }),
    );
  });

  it('rejects a basic credential pair that is only half filled in', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'basic');
    await user.type(screen.getByLabelText('Username'), 'svc-account');
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));

    expect(screen.getByText('Both username and password are required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a bearer token containing a control character or exceeding 4096 characters', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<SubscriberForm submitLabel="Create subscriber" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Name'), 'Stripe');
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com/hooks/stripe');
    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'bearer');
    const tokenInput = screen.getByLabelText('Token');

    // CR/LF never reach state — the input's value sanitization strips them
    // before React sees the value — so the guard is pinned with a control
    // character that survives sanitization (same forbidden class as the DTO).
    fireEvent.change(tokenInput, { target: { value: 'tok_bad\tinjected' } });
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));
    expect(
      screen.getByText('Token must be 1–4096 characters of one line.'),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(tokenInput, { target: { value: 'x'.repeat(4097) } });
    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));
    expect(
      screen.getByText('Token must be 1–4096 characters of one line.'),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
