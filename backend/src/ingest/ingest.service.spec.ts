import 'reflect-metadata';
import 'dotenv/config';

import { createHmac } from 'node:crypto';
import {
  HttpStatus,
  INestApplication,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { MAX_BODY_BYTES, SIGNATURE_PREFIX } from '../common/constants/ingest.constants';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { RejectReason, RecordStatus } from '../generated/prisma/enums';
import { ingestRawBodyMiddleware } from './middleware/ingest-raw-body.middleware';
import { IngestModule } from './ingest.module';
import { IngestService, type IngestRequestInput } from './ingest.service';
import { RateLimitService } from './rate-limit.service';

jest.setTimeout(30_000);

const SUBSCRIBER_ID = 7;
const HMAC_SECRET = 'spec-hmac-secret';
const SIGNATURE_HEADER = 'X-Hub-Signature-256';
const TOKEN = 'spec-token';

interface SubscriberSeed {
  id: number;
  revokedAt: Date | null;
  signatureHeaderName: string;
  hmacSecret: string;
}

function activeSubscriber(overrides: Partial<SubscriberSeed> = {}): SubscriberSeed {
  return {
    id: SUBSCRIBER_ID,
    revokedAt: null,
    signatureHeaderName: SIGNATURE_HEADER,
    hmacSecret: HMAC_SECRET,
    ...overrides,
  };
}

interface PrismaMock {
  subscriber: { findUnique: jest.Mock };
  webhookRecord: { create: jest.Mock };
  rateLimitWindow: { findMany: jest.Mock; create: jest.Mock };
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

function createPrismaMock(subscribers: SubscriberSeed[]): PrismaMock {
  const byToken = new Map(subscribers.map((s) => [TOKEN, s]));
  const byId = new Map(subscribers.map((s) => [s.id, s]));
  let nextRecordId = 100;

  const tx: PrismaMock = {
    subscriber: {
      findUnique: jest.fn(async ({ where }: { where: { ingestToken?: string; id?: number } }) => {
        if (where.ingestToken !== undefined) {
          return byToken.get(where.ingestToken) ?? null;
        }
        if (where.id !== undefined) {
          return byId.get(where.id) ?? null;
        }
        return null;
      }),
    },
    webhookRecord: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: nextRecordId++,
        ...data,
      })),
    },
    rateLimitWindow: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ dbNow: new Date() }]),
    $transaction: jest.fn(),
  };
  tx.$transaction.mockImplementation(async <T>(fn: (t: PrismaMock) => Promise<T>) => fn(tx));
  return tx;
}

function baseInput(overrides: Partial<IngestRequestInput> = {}): IngestRequestInput {
  const body = Buffer.from('{"type":"order.created"}', 'utf8');
  return {
    token: TOKEN,
    rawBody: body,
    bodyOverflow: false,
    method: 'POST',
    url: '/ingest/spec-token',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': SIGNATURE_PREFIX + createHmac('sha256', HMAC_SECRET).update(body).digest('hex'),
    },
    ...overrides,
  };
}

function signWith(body: Buffer, secret: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(body).digest('hex');
}

describe('IngestService.handle — §3.3 status contract (table-driven)', () => {
  interface ContractCase {
    name: string;
    subscribers: SubscriberSeed[];
    input: IngestRequestInput;
    admitRate: boolean;
    expected: {
      status: HttpStatus;
      code?: string;
      reason?: string;
      countedInWindow: boolean;
      record: null | {
        status: RecordStatus;
        rejectReason: RejectReason | null;
        rawBody: string;
        bodyBytes: number;
      };
      usesTransaction: boolean;
    };
  }

  const overflowBody = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);

  const cases: ContractCase[] = [
    {
      name: '404 not_found — unknown token, no record, no rate window',
      subscribers: [activeSubscriber()],
      input: baseInput({ token: 'unknown-token' }),
      admitRate: true,
      expected: {
        status: HttpStatus.NOT_FOUND,
        code: 'not_found',
        countedInWindow: false,
        record: null,
        usesTransaction: false,
      },
    },
    {
      name: '410 subscriber_revoked — revoked token, no record, no rate window',
      subscribers: [activeSubscriber({ revokedAt: new Date('2026-01-01T00:00:00Z') })],
      input: baseInput(),
      admitRate: true,
      expected: {
        status: HttpStatus.GONE,
        code: 'subscriber_revoked',
        countedInWindow: false,
        record: null,
        usesTransaction: false,
      },
    },
    {
      name: '413 body_too_large — record REJECTED, sentinel bodyBytes, not counted, rate untouched',
      subscribers: [activeSubscriber()],
      input: baseInput({ rawBody: overflowBody, bodyOverflow: true }),
      admitRate: true,
      expected: {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        code: 'body_too_large',
        countedInWindow: false,
        record: {
          status: RecordStatus.REJECTED,
          rejectReason: RejectReason.BODY_TOO_LARGE,
          rawBody: '',
          bodyBytes: MAX_BODY_BYTES + 1,
        },
        usesTransaction: false,
      },
    },
    {
      name: '429 rate_limited — record REJECTED, window count unchanged, Retry-After present',
      subscribers: [activeSubscriber()],
      input: baseInput(),
      admitRate: false,
      expected: {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'rate_limited',
        countedInWindow: false,
        record: {
          status: RecordStatus.REJECTED,
          rejectReason: RejectReason.RATE_LIMITED,
          rawBody: '{"type":"order.created"}',
          bodyBytes: '{"type":"order.created"}'.length,
        },
        usesTransaction: false,
      },
    },
    {
      name: '401 missing_signature — no header, record REJECTED, counted in window',
      subscribers: [activeSubscriber()],
      input: baseInput({
        headers: { 'content-type': 'application/json' },
      }),
      admitRate: true,
      expected: {
        status: HttpStatus.UNAUTHORIZED,
        code: 'unauthorized',
        reason: 'missing_signature',
        countedInWindow: true,
        record: {
          status: RecordStatus.REJECTED,
          rejectReason: RejectReason.MISSING_SIGNATURE,
          rawBody: '{"type":"order.created"}',
          bodyBytes: '{"type":"order.created"}'.length,
        },
        usesTransaction: true,
      },
    },
    {
      name: '401 invalid_signature — wrong secret, record REJECTED, counted in window',
      subscribers: [activeSubscriber()],
      input: baseInput({
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signWith(Buffer.from('{"type":"order.created"}'), 'wrong-secret'),
        },
      }),
      admitRate: true,
      expected: {
        status: HttpStatus.UNAUTHORIZED,
        code: 'unauthorized',
        reason: 'invalid_signature',
        countedInWindow: true,
        record: {
          status: RecordStatus.REJECTED,
          rejectReason: RejectReason.INVALID_SIGNATURE,
          rawBody: '{"type":"order.created"}',
          bodyBytes: '{"type":"order.created"}'.length,
        },
        usesTransaction: true,
      },
    },
    {
      name: '200 verified — record VERIFIED, counted in window, no rejectReason',
      subscribers: [activeSubscriber()],
      input: baseInput(),
      admitRate: true,
      expected: {
        status: HttpStatus.OK,
        countedInWindow: true,
        record: {
          status: RecordStatus.VERIFIED,
          rejectReason: null,
          rawBody: '{"type":"order.created"}',
          bodyBytes: '{"type":"order.created"}'.length,
        },
        usesTransaction: true,
      },
    },
  ];

  it.each(cases)('$name', async (testCase) => {
    const prismaMock = createPrismaMock(testCase.subscribers);
    const rateAcquire = jest.fn().mockResolvedValue(
      testCase.admitRate
        ? { admitted: true as const }
        : { admitted: false as const, retryAfterSeconds: 7 },
    );
    const service = new IngestService(
      prismaMock as unknown as PrismaService,
      { acquire: rateAcquire } as unknown as RateLimitService,
    );

    const outcome = await service.handle(testCase.input);

    expect(outcome.status).toBe(testCase.expected.status);
    if (testCase.expected.code !== undefined) {
      expect((outcome as { code?: string }).code).toBe(testCase.expected.code);
    }
    if (testCase.expected.reason !== undefined) {
      expect((outcome as { reason?: string }).reason).toBe(testCase.expected.reason);
    }

    if (testCase.expected.record === null) {
      expect(prismaMock.webhookRecord.create).not.toHaveBeenCalled();
    } else {
      expect(prismaMock.webhookRecord.create).toHaveBeenCalledTimes(1);
      const data = prismaMock.webhookRecord.create.mock.calls[0][0].data as {
        status: RecordStatus;
        rejectReason: RejectReason | null;
        rawBody: string;
        bodyBytes: number;
      };
      expect(data.status).toBe(testCase.expected.record.status);
      expect(data.rejectReason).toBe(testCase.expected.record.rejectReason);
      expect(data.rawBody).toBe(testCase.expected.record.rawBody);
      expect(data.bodyBytes).toBe(testCase.expected.record.bodyBytes);
    }

    if (testCase.expected.countedInWindow) {
      // Capture path: limiter admitted (the real service inserts the window row).
      expect(rateAcquire).toHaveBeenCalledWith(testCase.subscribers[0].id);
    } else if (testCase.expected.code === 'rate_limited') {
      expect(rateAcquire).toHaveBeenCalledTimes(1);
      // A 429 must not insert into the window it was refused by.
      expect(prismaMock.rateLimitWindow.create).not.toHaveBeenCalled();
    } else {
      expect(rateAcquire).not.toHaveBeenCalled();
      expect(prismaMock.rateLimitWindow.create).not.toHaveBeenCalled();
    }

    if (testCase.expected.usesTransaction) {
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    } else {
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    }

    if (testCase.expected.status === HttpStatus.TOO_MANY_REQUESTS) {
      expect((outcome as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('C1: body size precedes rate — overflow + full window is still 413, limiter untouched', async () => {
    const prismaMock = createPrismaMock([activeSubscriber()]);
    const rateAcquire = jest.fn().mockResolvedValue({ admitted: false, retryAfterSeconds: 30 });
    const service = new IngestService(
      prismaMock as unknown as PrismaService,
      { acquire: rateAcquire } as unknown as RateLimitService,
    );

    const outcome = await service.handle(
      baseInput({ rawBody: overflowBody, bodyOverflow: true }),
    );

    expect(outcome.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(rateAcquire).not.toHaveBeenCalled();
    expect(prismaMock.rateLimitWindow.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.webhookRecord.create).toHaveBeenCalledTimes(1);
  });
});

describe('Ingest API — record-then-respond (§8.2)', () => {
  let app: INestApplication;
  let prismaMock: PrismaMock;
  let catchSpy: jest.SpyInstance;
  const body = Buffer.from('{"type":"order.created"}', 'utf8');

  beforeAll(async () => {
    catchSpy = jest.spyOn(HttpExceptionFilter.prototype, 'catch');

    prismaMock = createPrismaMock([activeSubscriber()]);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, IngestModule],
      providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    // Mirrors main.ts §4.1 order: raw capture for /ingest, then parsers.
    app.use('/ingest', ingestRawBodyMiddleware());
    await app.init();
  });

  beforeEach(() => {
    catchSpy.mockClear();
    prismaMock.webhookRecord.create.mockClear();
    prismaMock.rateLimitWindow.create.mockClear();
    prismaMock.rateLimitWindow.findMany.mockClear();
    prismaMock.$transaction.mockClear();
  });

  afterAll(async () => {
    catchSpy.mockRestore();
    await app?.close();
  });

  it('413 writes the record BEFORE the filter emits the response', async () => {
    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1);

    const res = await request(app.getHttpServer())
      .post(`/ingest/${TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(oversized);

    expect(res.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(res.body.error.code).toBe('body_too_large');
    expect(typeof res.body.error.requestId).toBe('string');

    expect(prismaMock.webhookRecord.create).toHaveBeenCalledTimes(1);
    const recordOrder = prismaMock.webhookRecord.create.mock.invocationCallOrder[0];
    const filterOrder = catchSpy.mock.invocationCallOrder[0];
    expect(recordOrder).toBeLessThan(filterOrder);
  });

  it('200 returns {data:{recordId,status:"verified"}} for a valid signature', async () => {
    const wire = body.toString('utf8');
    const res = await request(app.getHttpServer())
      .post(`/ingest/${TOKEN}`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signWith(body, HMAC_SECRET))
      .send(wire);

    expect(res.status).toBe(HttpStatus.OK);
    expect(res.body.data.status).toBe('verified');
    expect(typeof res.body.data.recordId).toBe('number');
  });

  it('401 missing_signature returns the envelope with reason', async () => {
    const res = await request(app.getHttpServer())
      .post(`/ingest/${TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(body.toString('utf8'));

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.body.error.details).toEqual({ reason: 'missing_signature' });
    expect(typeof res.body.error.requestId).toBe('string');
  });
});
