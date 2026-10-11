import { GoneException, HttpException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DestinationMethod, Prisma, RecordStatus, ReplayError } from '../generated/prisma/client';
import { MembershipService } from '../common/membership/membership.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RESPONSE_BODY_MAX_BYTES } from '../common/constants/app.constants';
import { AUTH_REDACTED_MARKER } from '../subscribers/destination-auth';
import { ReplayDto } from './dto/replay.dto';
import { ReplayService } from './replay.service';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'dns/promises';

const lookupMock = lookup as unknown as jest.Mock;

const USER_ID = 11;
const RECORD_ID = 41;
const SUBSCRIBER_ID = 7;
const WORKSPACE_ID = 3;
const DEST = 'https://dest.example/hook';

type FetchMock = jest.Mock;

interface RecordedCreateArgs {
  data: Record<string, unknown>;
}

function sourceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD_ID,
    subscriberId: SUBSCRIBER_ID,
    method: 'POST',
    url: 'https://hooks.example/ingest/abc',
    headers: { 'content-type': 'application/json' },
    rawBody: '{"type":"spec"}',
    bodyBytes: 15,
    status: RecordStatus.VERIFIED,
    rejectReason: null,
    eventType: 'spec.event',
    subscriber: {
      workspaceId: WORKSPACE_ID,
      revokedAt: null,
      destinationMethod: DestinationMethod.POST,
      destinationUrl: DEST,
      destinationHeaders: null,
      destinationAuth: null,
    },
    ...overrides,
  };
}

function okResponse(status: number, text: string): Response {
  return { status, text: async () => text } as unknown as Response;
}

async function captureHttpException(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('expected the replay call to reject');
}

describe('ReplayService', () => {
  const prismaMock = {
    webhookRecord: { findUnique: jest.fn(), create: jest.fn() },
  };
  const membershipMock = { assertMember: jest.fn() };
  let service: ReplayService;
  let fetchMock: FetchMock;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReplayService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MembershipService, useValue: membershipMock },
      ],
    }).compile();
    service = moduleRef.get(ReplayService);
  });

  beforeEach(() => {
    lookupMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    prismaMock.webhookRecord.findUnique.mockReset().mockResolvedValue(sourceRecord());
    prismaMock.webhookRecord.create
      .mockReset()
      .mockImplementation(async (args: RecordedCreateArgs) => ({ id: 90, replayedAt: args.data.replayedAt }));
    membershipMock.assertMember.mockReset().mockResolvedValue(undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('sends the subscriber destination leg and returns 200-shaped success', async () => {
    fetchMock.mockResolvedValue(okResponse(200, '{"ok":true}'));
    const dto: ReplayDto = { body: { hello: 'world' } };

    const result = await service.replay(RECORD_ID, USER_ID, dto);

    expect(result.data.replayRecordId).toBe(90);
    expect(result.data.outcome).toBe('ok');
    expect(result.data.response.status).toBe(200);
    expect(result.data.response.body).toBe('{"ok":true}');
    expect(result.data.response.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.data.savedAt).toBe('string');

    const [urlArg, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(urlArg)).toBe(DEST);
    expect(initArg.method).toBe(DestinationMethod.POST);
    expect(initArg.headers).toEqual({ 'content-type': 'application/json' });
    expect(initArg.body).toBe(JSON.stringify(dto.body));
    expect(initArg.redirect).toBe('manual');
    expect(initArg.signal).toBeInstanceOf(AbortSignal);

    const createArgs = prismaMock.webhookRecord.create.mock.calls[0]?.[0] as { data: RecordedCreateArgs };
    expect(createArgs.data).toEqual(
      expect.objectContaining({
        subscriberId: SUBSCRIBER_ID,
        method: 'POST',
        url: 'https://hooks.example/ingest/abc',
        rawBody: '{"type":"spec"}',
        replayOfId: RECORD_ID,
        replayTargetUrl: DEST,
        responseStatus: 200,
        responseBody: '{"ok":true}',
        replayError: null,
        replayedAt: expect.any(Date),
        durationMs: expect.any(Number),
      }),
    );
  });

  it("lets destination headers override the default content-type (spread order, §4.5)", async () => {
    fetchMock.mockResolvedValue(okResponse(204, ''));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.PUT,
          destinationUrl: DEST,
          destinationHeaders: { 'content-type': 'application/cloudevents+json', 'x-tenant': 'acme' },
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: { a: 1 } });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.method).toBe(DestinationMethod.PUT);
    expect(initArg.headers).toEqual({
      'content-type': 'application/cloudevents+json',
      'x-tenant': 'acme',
    });
    expect(initArg.redirect).toBe('manual');
  });

  // — destinationAuth (02 §4): the credential is bound LAST so it always wins —
  // The outbound credential must never ride an echoing destination's response
  // body back into the API: httpbin reflects request headers by design, and
  // record detail persists that body verbatim — a plaintext credential in a
  // stored row (02 §4 "never serialized"). The wire value is scrubbed before
  // the body is stored and before it is returned to the caller.
  it('redacts an echoed credential so it never reaches the stored or returned body', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        200,
        JSON.stringify({ headers: { Authorization: 'Bearer tok-secret-XYZ', 'X-Trace': 't-1' } }),
      ),
    );
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: null,
          destinationAuth: { type: 'bearer', token: 'tok-secret-XYZ' },
        },
      }),
    );

    const result = await service.replay(RECORD_ID, USER_ID, { body: {} });

    const createArgs = prismaMock.webhookRecord.create.mock.calls[0]?.[0] as { data: RecordedCreateArgs };
    const stored = (createArgs.data as { responseBody?: string | null }).responseBody ?? '';
    expect(stored).not.toContain('tok-secret-XYZ');
    expect(stored).toContain(AUTH_REDACTED_MARKER);
    expect(stored).toContain('t-1'); // unrelated echoed fields survive the scrub
    expect(result.data.response.body).toBe(stored);
  });

  // WHATWG fetch strips leading/trailing OWS (SP and HTAB only) from every
  // header value before it reaches the wire, and an echo destination reflects
  // the WIRE spelling. The test above cannot catch that: its mock echoes the
  // init headers verbatim, so init and echo always agree. Here the mock applies
  // the same OWS strip undici performs before echoing, making the wire value
  // differ from the configured one — the shape that leaked a padded credential.
  it('redacts a padded credential that the wire trims to a different spelling', async () => {
    const OWS = /^[ \t]+|[ \t]+$/g;
    fetchMock.mockImplementation(async (_url: URL, init: RequestInit) => {
      const wireHeaders = Object.fromEntries(
        Object.entries(init.headers as Record<string, string>).map(([name, headerValue]) => [
          name,
          headerValue.replace(OWS, ''),
        ]),
      );
      return okResponse(200, JSON.stringify({ headers: wireHeaders, 'X-Trace': 't-2' }));
    });
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: null,
          destinationAuth: { type: 'bearer', token: 'tok-secret-XYZ ' },
        },
      }),
    );

    const result = await service.replay(RECORD_ID, USER_ID, { body: {} });

    // The object fetch was handed must already be the wire spelling — init and
    // wire cannot disagree on the value the redaction will target.
    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((initArg.headers as Record<string, string>).authorization).toBe('Bearer tok-secret-XYZ');

    const createArgs = prismaMock.webhookRecord.create.mock.calls[0]?.[0] as { data: RecordedCreateArgs };
    const stored = (createArgs.data as { responseBody?: string | null }).responseBody ?? '';
    expect(stored).not.toContain('tok-secret-XYZ');
    expect(stored).toContain(AUTH_REDACTED_MARKER);
    expect(stored).toContain('t-2'); // unrelated echoed fields survive the scrub
    expect(result.data.response.body).toBe(stored);
  });

  it.each([
    ['bearer', { type: 'bearer', token: 'tok-abc' }, { authorization: 'Bearer tok-abc' }],
    [
      'basic',
      { type: 'basic', username: 'svc', password: 'p@ss' },
      { authorization: `Basic ${Buffer.from('svc:p@ss').toString('base64')}` },
    ],
    ['apiKey', { type: 'apiKey', headerName: 'X-Api-Key', value: 'v-1' }, { 'X-Api-Key': 'v-1' }],
  ] as const)('sends the %s credential as the outbound auth header', async (
    _type,
    destinationAuth,
    expectedHeader,
  ) => {
    fetchMock.mockResolvedValue(okResponse(200, '{}'));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: null,
          destinationAuth,
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: {} });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.headers).toEqual({ 'content-type': 'application/json', ...expectedHeader });
  });

  it('a configured credential beats a destinationHeaders entry naming the same header', async () => {
    fetchMock.mockResolvedValue(okResponse(200, '{}'));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: { authorization: 'Bearer stale-token' },
          destinationAuth: { type: 'bearer', token: 'fresh-token' },
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: {} });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer fresh-token',
    });
  });

  // HTTP field names are case-insensitive but object spread is not: a naive
  // {...dest, ...credential} leaves BOTH keys in the map and undici comma-joins
  // them ("Bearer stale, Bearer fresh") — the credential never wins on the wire.
  it('drops a case-variant destinationHeaders Authorization so only the credential is sent', async () => {
    fetchMock.mockResolvedValue(okResponse(200, '{}'));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: { Authorization: 'Bearer stale-token' },
          destinationAuth: { type: 'bearer', token: 'fresh-token' },
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: {} });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer fresh-token',
    });
  });

  it('drops a case-variant destinationHeaders apiKey name so only the credential value is sent', async () => {
    fetchMock.mockResolvedValue(okResponse(200, '{}'));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: { 'x-api-key': 'stale-value' },
          destinationAuth: { type: 'apiKey', headerName: 'X-Api-Key', value: 'fresh-value' },
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: {} });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.headers).toEqual({
      'content-type': 'application/json',
      'X-Api-Key': 'fresh-value',
    });
  });

  // §4.5 promises destination headers may override our default content-type —
  // 'Content-Type' is the common spelling, and without case-insensitive merge
  // it comma-joins with the default into an unparseable value instead.
  it('lets a Content-Type destination header override the default without comma-joining', async () => {
    fetchMock.mockResolvedValue(okResponse(204, ''));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: { 'Content-Type': 'application/cloudevents+json' },
          destinationAuth: null,
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: {} });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.headers).toEqual({
      'Content-Type': 'application/cloudevents+json',
    });
  });

  it('degrades a malformed legacy credential to no header instead of throwing', async () => {
    fetchMock.mockResolvedValue(okResponse(200, '{}'));
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: null,
          // A CR/LF in the value must never split the outbound header block.
          destinationAuth: { type: 'bearer', token: 'a\r\nX-Evil: 1' },
        },
      }),
    );

    await service.replay(RECORD_ID, USER_ID, { body: {} });

    const [, initArg] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(initArg.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('blocks a private target BEFORE any record is written or fetch is called', async () => {
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: null,
          destinationMethod: DestinationMethod.POST,
          destinationUrl: 'http://127.0.0.1:9999/hook',
          destinationHeaders: null,
          destinationAuth: null,
        },
      }),
    );

    const error = await captureHttpException(service.replay(RECORD_ID, USER_ID, { body: {} }));
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      error: {
        code: 'replay_target_blocked',
        message: expect.any(String),
        details: { blockedIp: '127.0.0.1' },
      },
    });
    expect(prismaMock.webhookRecord.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when DNS resolution fails', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));

    const error = await captureHttpException(service.replay(RECORD_ID, USER_ID, { body: {} }));
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      error: {
        code: 'replay_target_blocked',
        message: expect.any(String),
        details: { blockedIp: null },
      },
    });
    expect(prismaMock.webhookRecord.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 410 subscriber_revoked for a revoked subscriber — no record, no fetch', async () => {
    prismaMock.webhookRecord.findUnique.mockResolvedValue(
      sourceRecord({
        subscriber: {
          workspaceId: WORKSPACE_ID,
          revokedAt: new Date('2026-09-01T00:00:00.000Z'),
          destinationMethod: DestinationMethod.POST,
          destinationUrl: DEST,
          destinationHeaders: null,
          destinationAuth: null,
        },
      }),
    );

    const error = await captureHttpException(service.replay(RECORD_ID, USER_ID, { body: {} }));
    expect(error).toBeInstanceOf(GoneException);
    expect(error.getStatus()).toBe(410);
    expect(error.getResponse()).toEqual({
      error: { code: 'subscriber_revoked', message: expect.any(String) },
    });
    expect(prismaMock.webhookRecord.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an unknown record without touching membership or fetch', async () => {
    prismaMock.webhookRecord.findUnique.mockResolvedValue(null);

    await expect(service.replay(999_999, USER_ID, { body: {} })).rejects.toBeInstanceOf(NotFoundException);
    expect(membershipMock.assertMember).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates the membership 404 for a non-member', async () => {
    membershipMock.assertMember.mockRejectedValue(new NotFoundException({ message: 'workspace not found' }));

    await expect(service.replay(RECORD_ID, USER_ID, { body: {} })).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.webhookRecord.create).not.toHaveBeenCalled();
  });

  it('records a timeout leg and answers 504 replay_timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));

    const error = await captureHttpException(service.replay(RECORD_ID, USER_ID, { body: {} }));
    expect(error.getStatus()).toBe(504);
    expect(error.getResponse()).toEqual({
      error: {
        code: 'replay_timeout',
        message: expect.any(String),
        details: { replayRecordId: 90 },
      },
    });
    const createArgs = prismaMock.webhookRecord.create.mock.calls[0]?.[0] as { data: RecordedCreateArgs };
    expect(createArgs.data).toEqual(
      expect.objectContaining({
        replayError: ReplayError.REPLAY_TIMEOUT,
        responseStatus: null,
        responseBody: null,
        replayOfId: RECORD_ID,
      }),
    );
  });

  it('records a transport failure and answers 502 replay_upstream_error', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const error = await captureHttpException(service.replay(RECORD_ID, USER_ID, { body: {} }));
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toEqual({
      error: {
        code: 'replay_upstream_error',
        message: expect.any(String),
        details: { replayRecordId: 90 },
      },
    });
    const createArgs = prismaMock.webhookRecord.create.mock.calls[0]?.[0] as { data: RecordedCreateArgs };
    const replayErrorOnCreate = (createArgs.data as { replayError?: ReplayError }).replayError;
    expect(replayErrorOnCreate).toBe(ReplayError.REPLAY_UPSTREAM_ERROR);
  });

  it('maps a retention race (P2025 on the replay insert) to 404, not 500', async () => {
    fetchMock.mockResolvedValue(okResponse(200, 'ok'));
    prismaMock.webhookRecord.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Record to create not found.', {
        code: 'P2025',
        clientVersion: '7.10.0',
      }),
    );

    const error = await captureHttpException(service.replay(RECORD_ID, USER_ID, { body: {} }));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ message: 'record expired between read and insert' });
    // Persistence runs exactly once: the transport catch must not re-enter on a
    // P2025 thrown by the success-path insert and rewrite a second row.
    expect(prismaMock.webhookRecord.create).toHaveBeenCalledTimes(1);
  });

  it('truncates a oversized response body to the shared storage cap', async () => {
    const hugeBody = 'x'.repeat(RESPONSE_BODY_MAX_BYTES + 64);
    fetchMock.mockResolvedValue(okResponse(200, hugeBody));

    const result = await service.replay(RECORD_ID, USER_ID, { body: {} });

    expect(result.data.response.body).not.toBeNull();
    expect(Buffer.from(result.data.response.body ?? '', 'utf8')).toHaveLength(RESPONSE_BODY_MAX_BYTES);
  });
});
