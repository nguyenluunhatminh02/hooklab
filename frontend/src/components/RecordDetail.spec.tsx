import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import type { RecordDetail as RecordDetailData } from '../api/records';
import { RecordDetail } from './RecordDetail';

/**
 * Detail panel + replay block (04 §4/§6). Beyond plain rendering these specs
 * pin the decisions that were easy to get wrong:
 *
 * - the right comparison column reads the DESTINATION url (outbound leg,
 *   01 §137 §185), never a copy of the ingest url;
 * - the stored replay row (capture-time `replayTargetUrl` snapshot) wins
 *   over the synthesized fresh child as soon as the refetched row exists;
 * - a revoked subscriber (or 410) disables the editor with ONE reason
 *   banner — no duplicate alert;
 * - a 404 from the replay POST hands control to the page via `onExpired`.
 */

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } }),
  } as unknown as Response;
}

const DESTINATION_URL = 'https://hooks.example/shipments';

function makeRecord(overrides: Partial<RecordDetailData> = {}): RecordDetailData {
  return {
    id: 902,
    subscriberId: 7,
    workspaceId: 1,
    subscriberName: 'acme',
    status: 'verified',
    reason: null,
    eventType: 'shipment.created',
    method: 'POST',
    bodyBytes: 128,
    isReplay: false,
    replayOfId: null,
    replayResponseStatus: null,
    receivedAt: '2026-10-08T21:00:00.000Z',
    url: 'https://sender.example/hooks/inbound',
    headers: { 'content-type': 'application/json' },
    rawBody: '{"event":"shipment.created","id":"shp_42"}',
    bodyParsed: { event: 'shipment.created', id: 'shp_42' },
    destination: { method: 'POST', url: DESTINATION_URL, headers: {} },
    replays: [],
    ...overrides,
  };
}

function savedChild(id: number): RecordDetailData['replays'][number] {
  return {
    id,
    receivedAt: '2026-10-08T21:05:00.000Z',
    request: { method: 'POST', url: DESTINATION_URL, headers: {}, rawBody: '{"id":"shp_42"}' },
    response: { outcome: 'ok', status: 200, body: '{"accepted":true}', durationMs: 143 },
  };
}

const replayEnvelope = {
  replayRecordId: 903,
  outcome: 'ok',
  response: { status: 201, body: '{"accepted":true,"id":"shp_42"}', durationMs: 143 },
  savedAt: '2026-10-08T21:05:00.000Z',
};

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('RecordDetail', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the captured request and the live destination', () => {
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByRole('heading', { name: /Request detail/ })).toBeInTheDocument();
    expect(screen.getByText(/sender\.example\/hooks\/inbound/)).toBeInTheDocument();
    expect(screen.getByText(/hooks\.example\/shipments/)).toBeInTheDocument();
  });

  it('replays the edited body and renders the round trip against the destination URL', async () => {
    fetchMock.mockResolvedValue(okJson({ data: replayEnvelope }));
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() => expect(screen.getByTestId('replay-outcome')).toBeInTheDocument());

    // The comparison's right column reads the DESTINATION (outbound leg) —
    // the ingest url is the left column's story, never the replay's.
    const replayCol = screen.getByRole('heading', { name: 'Replay response' }).closest('.replay-col');
    if (replayCol === null) throw new Error('replay column missing');
    expect(within(replayCol as HTMLElement).getByText(/hooks\.example\/shipments/)).toBeInTheDocument();
    expect(within(replayCol as HTMLElement).queryByText(/sender\.example/)).not.toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(postCall).toBeDefined();
    expect(String(postCall?.[0])).toBe('/api/records/902/replay');
    const sent = JSON.parse(String(postCall?.[1]?.body));
    expect(sent).toEqual({ body: { event: 'shipment.created', id: 'shp_42' } });

    expect(screen.getByTestId('replay-outcome')).toHaveTextContent('ok');
    expect(screen.getByTestId('replay-status')).toHaveTextContent('HTTP 201');
    expect(screen.getByText(/accepted/)).toBeInTheDocument();
  });

  it('prefers the stored replay row once it exists — its url is the capture-time destination', async () => {
    // The record already carries its stored child (record.replays, capture-time
    // replayTargetUrl snapshot) while the LIVE destination was edited after the
    // replay. The comparison must keep telling where the replay actually went.
    const record = makeRecord({
      replays: [savedChild(903)],
      destination: { method: 'POST', url: 'https://edited.example/elsewhere', headers: {} },
    });
    fetchMock.mockResolvedValue(okJson({ data: replayEnvelope }));
    const user = userEvent.setup();
    render(<RecordDetail record={record} onClose={vi.fn()} />, { wrapper: Wrapper });

    // Stored row renders immediately; the fresh POST resolves to the same id
    // (903), which is not strictly newer — so the snapshot keeps winning.
    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() => expect(screen.getByTestId('replay-outcome')).toBeInTheDocument());

    const replayCol = screen.getByRole('heading', { name: 'Replay response' }).closest('.replay-col');
    if (replayCol === null) throw new Error('replay column missing');
    expect(within(replayCol as HTMLElement).getByText(/hooks\.example\/shipments/)).toBeInTheDocument();
    expect(within(replayCol as HTMLElement).queryByText(/edited\.example/)).not.toBeInTheDocument();
  });

  it('a revoked subscriber keeps the editor mounted but disabled with one reason banner (no duplicate alert)', () => {
    render(
      <RecordDetail
        record={makeRecord()}
        onClose={vi.fn()}
        replayDisabled
        replayReason="Replay is disabled for a revoked subscriber — its destination is no longer a live target."
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByRole('status')).toHaveTextContent(/no longer a live target/i);
    expect(screen.getByRole('button', { name: 'Replay request' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Replay body' })).toBeDisabled();
    // The reason banner IS the message — an alert repeating it would double up.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 410 from the replay POST disables the editor via its reason line, not an extra banner', async () => {
    fetchMock.mockResolvedValue(apiError(410, 'subscriber_revoked', 'Subscriber revoked'));
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/no live destination/i),
    );
    expect(screen.getByRole('button', { name: 'Replay request' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 404 from the replay POST hands control to the page via onExpired', async () => {
    const onExpired = vi.fn();
    fetchMock.mockResolvedValue(apiError(404, 'unknown_error', 'Record not found'));
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} onExpired={onExpired} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
  });

  it('a destination-side 502 shows the retryable banner and keeps the editor usable', async () => {
    fetchMock.mockResolvedValue(apiError(502, 'upstream_error', 'Destination unreachable'));
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/destination unreachable/i),
    );
    expect(screen.getByRole('button', { name: 'Replay request' })).toBeEnabled();
    // Retryable — nothing to edit, so no edit-form link (that is the 400's job).
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('a 504 banner offers to open the saved attempt from details.replayRecordId (04 §6/02 §412)', async () => {
    const onOpenRecord = vi.fn();
    fetchMock.mockResolvedValue(
      apiError(504, 'replay_timeout', 'Destination did not respond within 10 s', {
        replayRecordId: 77,
      }),
    );
    const user = userEvent.setup();
    render(
      <RecordDetail record={makeRecord()} onClose={vi.fn()} onOpenRecord={onOpenRecord} />,
      { wrapper: Wrapper },
    );

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByTestId('replay-error')).toHaveAttribute('data-kind', 'timeout'),
    );

    // The attempt row was saved — the banner opens it in the timeline.
    await user.click(screen.getByRole('button', { name: /open the saved attempt/i }));
    expect(onOpenRecord).toHaveBeenCalledWith(77);
  });

  it('a 504 without details has no affordance to render', async () => {
    fetchMock.mockResolvedValue(apiError(504, 'replay_timeout', 'Destination did not respond'));
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByTestId('replay-error')).toHaveAttribute('data-kind', 'timeout'),
    );
    expect(
      screen.queryByRole('button', { name: /open the saved attempt/i }),
    ).not.toBeInTheDocument();
  });

  it('a 502 stays retry-only even when the backend sends details (spec: no affordance)', async () => {
    // 02 §6 sends replayRecordId on the 504 row only, but the backend happens
    // to include details on 502 too — 04 §163 specs that banner as retry only.
    const onOpenRecord = vi.fn();
    fetchMock.mockResolvedValue(
      apiError(502, 'upstream_error', 'Destination unreachable', { replayRecordId: 77 }),
    );
    const user = userEvent.setup();
    render(
      <RecordDetail record={makeRecord()} onClose={vi.fn()} onOpenRecord={onOpenRecord} />,
      { wrapper: Wrapper },
    );

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/destination unreachable/i),
    );
    expect(
      screen.queryByRole('button', { name: /open the saved attempt/i }),
    ).not.toBeInTheDocument();
    expect(onOpenRecord).not.toHaveBeenCalled();
  });

  it('a 400 SSRF block links the banner to the subscriber edit form (04 §6)', async () => {
    fetchMock.mockResolvedValue(apiError(400, 'replay_target_blocked', 'Target blocked'));
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByTestId('replay-error')).toHaveAttribute('data-kind', 'blocked'),
    );
    // The only fix is editing the destination, so the banner carries the jump
    // link to the page's edit section — and the editor stays usable.
    const link = screen.getByRole('link', { name: /edit the destination url/i });
    expect(link).toHaveAttribute('href', '#edit-heading');
    expect(screen.getByRole('textbox', { name: 'Replay body' })).toBeEnabled();
  });

  it('a 413 body cap answer keeps the editor open so the body can be shortened', async () => {
    fetchMock.mockResolvedValue(
      apiError(413, 'body_too_large', 'request body exceeds 1048576 bytes'),
    );
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    await waitFor(() =>
      expect(screen.getByTestId('replay-error')).toHaveAttribute('data-kind', 'tooLarge'),
    );
    // Terminal for this body only — not a disabled editor (410) and not a
    // pre-filled reason banner: the user must be able to edit and resubmit.
    expect(screen.getByRole('textbox', { name: 'Replay body' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replay request' })).toBeEnabled();
  });

  it('shows the in-flight label and disables the controls while the replay is in flight', async () => {
    let releasePost: (value: Response) => void = () => {};
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          releasePost = resolve;
        });
      }
      return Promise.resolve(okJson(null));
    });
    const user = userEvent.setup();
    render(<RecordDetail record={makeRecord()} onClose={vi.fn()} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    expect(screen.getByRole('button', { name: 'Replaying…' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Replay body' })).toBeDisabled();

    releasePost(okJson({ data: replayEnvelope }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Replay request' })).toBeEnabled(),
    );
  });
});