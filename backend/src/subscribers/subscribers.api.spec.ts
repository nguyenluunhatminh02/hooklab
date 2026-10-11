// SubscribersService re-validates env at construction (single source of truth
// with main.ts), and the full Joi gate includes DATABASE_URL — load .env here
// the same way rotate-race.spec does, before the testing module compiles.
import 'dotenv/config';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { DestinationMethod, RecordStatus, Role } from '../generated/prisma/enums';
import { Prisma, type Subscriber } from '../generated/prisma/client';
import { SubscribersModule } from './subscribers.module';
import { MembershipModule } from '../common/membership/membership.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JWT_ALGORITHM } from '../auth/auth.constants';
import { MAX_DESTINATION_HEADERS } from '../common/constants/app.constants';
import {
  DESTINATION_HEADER_NAME_MAX_LENGTH,
  DESTINATION_HEADER_VALUE_MAX_LENGTH,
  REVOKE_NOTE,
  ROTATE_NOTE,
} from './subscribers.constants';

const JWT_SECRET = 'subscribers-api-spec-secret-0123456789';
const PUBLIC_BASE_URL = 'http://hooklab.test';
const CALLER_ID = 1;
const STRANGER_ID = 2;
const WORKSPACE_ID = 7;
const SUBSCRIBER_ID = 11;
const NEW_SUBSCRIBER_ID = 12;
const TOKEN = 'a1b2c3d4'.repeat(8);
const SECRET = 'abcdef0123456789'.repeat(4);
const DESTINATION_URL = 'https://hooks.example.test/stripe';

interface PrismaMock {
  membership: { findUnique: jest.Mock };
  subscriber: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  webhookRecord: { groupBy: jest.Mock };
  rateLimitWindow: { deleteMany: jest.Mock };
  $transaction: jest.Mock;
  $executeRaw: jest.Mock;
}

describe('subscribers API (02 §4 routes + secret-exposure gates)', () => {
  let app: INestApplication;

  const prismaMock: PrismaMock = {
    membership: { findUnique: jest.fn() },
    subscriber: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    webhookRecord: { groupBy: jest.fn() },
    rateLimitWindow: { deleteMany: jest.fn() },
    $transaction: jest.fn(
      async (fn: (tx: PrismaMock) => Promise<unknown>): Promise<unknown> => fn(prismaMock),
    ),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    process.env.JWT_SECRET = JWT_SECRET;
    const moduleRef = await Test.createTestingModule({
      // MembershipModule is @Global() at the app root; this isolated testing
      // module never imports AppModule, so the global registration must be
      // repeated here for SubscribersService's MembershipService dependency.
      imports: [PrismaModule, MembershipModule, SubscribersModule],
      providers: [
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
          }),
        },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        // AuthModule owns JwtStrategy's usual registration with passport; it is
        // not imported here, so the strategy is provided directly — the guard
        // above would otherwise fail every request with "unknown strategy jwt".
        JwtStrategy,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.membership.findUnique.mockResolvedValue(null);
    prismaMock.subscriber.findMany.mockResolvedValue([]);
    prismaMock.subscriber.findUnique.mockResolvedValue(null);
    prismaMock.webhookRecord.groupBy.mockResolvedValue([]);
    prismaMock.subscriber.create.mockImplementation(
      async ({ data }: { data: Partial<Subscriber> }) =>
        subscriberRow({
          ...data,
          // DbNull is a Prisma write-only sentinel; a real read-back of an SQL
          // NULL column returns plain null, so the mock normalizes it here.
          destinationAuth:
            (data.destinationAuth as unknown) === Prisma.DbNull ? null : data.destinationAuth,
          id: NEW_SUBSCRIBER_ID,
        }),
    );
    // The update mock patches the row returned by findUnique like a real
    // store: fields absent from the write payload survive untouched (PATCH
    // semantics — e.g. destinationAuth absent keeps the stored credential).
    prismaMock.subscriber.update.mockImplementation(
      async ({ where, data }: { where: { id: number }; data: Partial<Subscriber> }) => {
        const current = (await prismaMock.subscriber.findUnique.mock.results.at(-1)?.value) as
          | Subscriber
          | null;
        return subscriberRow({
          ...(current ?? subscriberRow()),
          ...definedFields(data),
          // DbNull is a Prisma write-only sentinel; a real read-back of an SQL
          // NULL column returns plain null, so the mock normalizes it here.
          destinationAuth:
            data.destinationAuth === undefined
              ? (current?.destinationAuth ?? null)
              : (data.destinationAuth as unknown) === Prisma.DbNull
                ? null
                : data.destinationAuth,
          id: where.id,
        });
      },
    );
    prismaMock.subscriber.delete.mockResolvedValue({ id: SUBSCRIBER_ID });
    prismaMock.rateLimitWindow.deleteMany.mockResolvedValue({ count: 0 });
  });

  function tokenFor(userId: number): string {
    return sign({ sub: userId, email: `user${userId}@example.com` }, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '1h',
    });
  }

  function authFor(userId: number): string {
    return `Bearer ${tokenFor(userId)}`;
  }

  it('GET list returns summaries with canonical badge counts (member)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findMany.mockResolvedValue([subscriberRow()]);
    prismaMock.webhookRecord.groupBy.mockResolvedValue([
      { subscriberId: SUBSCRIBER_ID, status: RecordStatus.VERIFIED, _count: { _all: 4 } },
      { subscriberId: SUBSCRIBER_ID, status: RecordStatus.REJECTED, _count: { _all: 1 } },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual({
      data: [
        {
          id: SUBSCRIBER_ID,
          workspaceId: WORKSPACE_ID,
          name: 'Stripe',
          status: 'active',
          endpointUrl: `${PUBLIC_BASE_URL}/ingest/${TOKEN}`,
          ingestToken: TOKEN,
          destination: {
            method: DestinationMethod.POST,
            url: DESTINATION_URL,
            headers: { 'x-env': 'prod' },
            auth: { type: 'none' },
          },
          signatureHeader: 'X-Hub-Signature-256',
          receivedCount: 5,
          verifiedCount: 4,
          rejectedCount: 1,
          createdAt: '2026-03-01T10:00:00.000Z',
          revokedAt: null,
        },
      ],
    });
    // Badge counts flow through the canonical replayOfId filter (02 §10).
    expect(prismaMock.webhookRecord.groupBy).toHaveBeenCalledWith({
      by: ['subscriberId', 'status'],
      where: { subscriberId: { in: [SUBSCRIBER_ID] }, replayOfId: null },
      _count: { _all: true },
    });
  });

  it('GET list answers 404 for a non-member', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(STRANGER_ID));

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.error.code).toBe('not_found');
    expect(prismaMock.subscriber.findMany).not.toHaveBeenCalled();
  });

  it('POST create answers 404 for a non-member (existence hiding, 02 §4)', async () => {
    // beforeEach leaves membership null, so the membership gate fires before
    // any store access — the subscriber row itself never has to exist.
    const response = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(STRANGER_ID))
      .send({ name: 'Stripe', destinationUrl: DESTINATION_URL });

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.error.code).toBe('not_found');
    expect(prismaMock.subscriber.create).not.toHaveBeenCalled();
  });

  it('POST create (201) returns the one-time secret and builds endpointUrl', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });

    const response = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'Stripe', destinationUrl: DESTINATION_URL });

    expect(response.status).toBe(HttpStatus.CREATED);
    const created = prismaMock.subscriber.create.mock.calls[0][0].data as {
      ingestToken: string;
      hmacSecret: string;
    };
    expect(created.ingestToken).toMatch(/^[0-9a-f]{64}$/);
    expect(created.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.ingestToken).not.toBe(created.hmacSecret);
    expect(prismaMock.subscriber.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        name: 'Stripe',
        ingestToken: created.ingestToken,
        hmacSecret: created.hmacSecret,
        destinationMethod: DestinationMethod.POST,
        destinationUrl: DESTINATION_URL,
        destinationHeaders: {},
        destinationAuth: Prisma.DbNull,
        signatureHeaderName: 'X-Hub-Signature-256',
      },
    });
    expect(response.body.data).toEqual({
      id: NEW_SUBSCRIBER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Stripe',
      status: 'active',
      endpointUrl: `${PUBLIC_BASE_URL}/ingest/${created.ingestToken}`,
      ingestToken: created.ingestToken,
      destination: {
        method: DestinationMethod.POST,
        url: DESTINATION_URL,
        headers: {},
        auth: { type: 'none' },
      },
      signatureHeader: 'X-Hub-Signature-256',
      receivedCount: 0,
      verifiedCount: 0,
      rejectedCount: 0,
      createdAt: '2026-03-01T10:00:00.000Z',
      revokedAt: null,
      secretHint: `…${created.hmacSecret.slice(-4)}`,
      secret: created.hmacSecret,
    });
  });

  it('POST rejects a blank/oversized name, an unknown field, and a bad signature header', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });

    const blankName = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: '', destinationUrl: DESTINATION_URL });
    const oversizedName = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'x'.repeat(81), destinationUrl: DESTINATION_URL });
    const unknownField = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'Fine', destinationUrl: DESTINATION_URL, token: 'sneaky' });
    const badSignatureHeader = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({
        name: 'Fine',
        destinationUrl: DESTINATION_URL,
        signatureHeader: 'X-Bad Header!',
      });
    // '' is NOT "absent": @IsOptional only skips null/undefined, so a blank
    // string hits @Matches and 400s. The frontend form must omit the key —
    // caught live on 2026-10-10 when every form-created subscriber 400'd.
    const emptySignatureHeader = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({
        name: 'Fine',
        destinationUrl: DESTINATION_URL,
        signatureHeader: '',
      });

    for (const response of [
      blankName,
      oversizedName,
      unknownField,
      badSignatureHeader,
      emptySignatureHeader,
    ]) {
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    }
    expect(prismaMock.subscriber.create).not.toHaveBeenCalled();
  });

  it('POST rejects destination headers that break the H-1 contract', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    const tooManyHeaders = Object.fromEntries(
      Array.from({ length: MAX_DESTINATION_HEADERS + 1 }, (_, index) => [`X-Hook-${index}`, 'ok']),
    );

    const rejectedBodies: Array<Record<string, unknown>> = [
      { destinationHeaders: tooManyHeaders },
      { destinationHeaders: { 'X Bad Name': 'ok' } },
      { destinationHeaders: { 'X-Evil\r\nX-Injected': 'ok' } },
      { destinationHeaders: { 'X-Ok': 'a\r\nb' } },
      { destinationHeaders: { 'X-Ok': 42 } },
      // Values fetch cannot carry: a control byte or above-Latin-1 text makes
      // the outbound leg throw, surfacing as a mislabeled 502 at replay.
      { destinationHeaders: { 'X-Ok': 'a\u0001b' } },
      { destinationHeaders: { 'X-Ok': 'vĀ' } },
    ];

    for (const extra of rejectedBodies) {
      const response = await request(app.getHttpServer())
        .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
        .set('Authorization', authFor(CALLER_ID))
        .send({ name: 'Stripe', destinationUrl: DESTINATION_URL, ...extra });
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    }
    expect(prismaMock.subscriber.create).not.toHaveBeenCalled();

    const accepted = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({
        name: 'Stripe',
        destinationUrl: DESTINATION_URL,
        // Interior HTAB is legal in a field value and survives the wire, so
        // the passthrough-value gate keeps allowing it.
        destinationHeaders: { 'X-Env': 'prod', 'X-Team': 'payments', 'X-Tab': 'a\tb' },
      });
    expect(accepted.status).toBe(HttpStatus.CREATED);
    expect(prismaMock.subscriber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destinationHeaders: { 'X-Env': 'prod', 'X-Team': 'payments', 'X-Tab': 'a\tb' },
        }),
      }),
    );
  });

  it('GET detail returns SubscriberDetail with secretHint and no secret', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());
    prismaMock.webhookRecord.groupBy.mockResolvedValue([
      { subscriberId: SUBSCRIBER_ID, status: RecordStatus.VERIFIED, _count: { _all: 2 } },
      { subscriberId: SUBSCRIBER_ID, status: RecordStatus.REJECTED, _count: { _all: 3 } },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data).toEqual({
      id: SUBSCRIBER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Stripe',
      status: 'active',
      endpointUrl: `${PUBLIC_BASE_URL}/ingest/${TOKEN}`,
      ingestToken: TOKEN,
      destination: {
        method: DestinationMethod.POST,
        url: DESTINATION_URL,
        headers: { 'x-env': 'prod' },
        auth: { type: 'none' },
      },
      signatureHeader: 'X-Hub-Signature-256',
      receivedCount: 5,
      verifiedCount: 2,
      rejectedCount: 3,
      createdAt: '2026-03-01T10:00:00.000Z',
      revokedAt: null,
      secretHint: `…${SECRET.slice(-4)}`,
    });
  });

  it('GET detail marks a subscriber with revokedAt as revoked', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(
      subscriberRow({ revokedAt: new Date('2026-05-06T07:08:09.000Z') }),
    );

    const response = await request(app.getHttpServer())
      .get(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.status).toBe('revoked');
    expect(response.body.data.revokedAt).toBe('2026-05-06T07:08:09.000Z');
  });

  it('GET detail answers 404 when the subscriber does not exist or the caller is no member', async () => {
    const missing = await request(app.getHttpServer())
      .get(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));

    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());
    const stranger = await request(app.getHttpServer())
      .get(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(STRANGER_ID));

    expect(missing.status).toBe(HttpStatus.NOT_FOUND);
    expect(stranger.status).toBe(HttpStatus.NOT_FOUND);
    expect(missing.body.error.code).toBe('not_found');
    expect(stranger.body.error.code).toBe('not_found');
  });

  it('PATCH updates only the provided fields (200) and rejects unknown fields (400)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'Renamed' });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.name).toBe('Renamed');
    // Fields the DTO left untouched survive the partial write (wire: destination.url).
    expect(response.body.data.destination.url).toBe(DESTINATION_URL);
    const updateData = (
      prismaMock.subscriber.update.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    // Prisma skips undefined keys, so the write payload carries only what changed.
    expect(updateData).toEqual({ name: 'Renamed' });

    const unknown = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ ingestToken: 'rewritten' });
    expect(unknown.status).toBe(HttpStatus.BAD_REQUEST);
    expect(prismaMock.subscriber.update).toHaveBeenCalledTimes(1);

    // Same '' trap as the create route: PATCH must omit the key to clear
    // nothing (the field has no "clear" semantic — it always carries a value).
    const emptySignature = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'Renamed', signatureHeader: '' });
    expect(emptySignature.status).toBe(HttpStatus.BAD_REQUEST);
    expect(prismaMock.subscriber.update).toHaveBeenCalledTimes(1);
  });

  it('PATCH with an empty body is a no-op (200, no write)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({});

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.name).toBe('Stripe');
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();
  });

  // — destinationAuth (02 §4): persist parsed credentials, mask readback —
  it('POST stores a parsed destinationAuth credential; the response shows only hints', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });

    const response = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({
        name: 'Stripe',
        destinationUrl: DESTINATION_URL,
        destinationAuth: { type: 'bearer', token: 'tok-abcdef' },
      });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(prismaMock.subscriber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destinationAuth: { type: 'bearer', token: 'tok-abcdef' },
        }),
      }),
    );
    // The stored token never serializes — only its hint does (02 §4).
    expect(response.body.data.destination.auth).toEqual({ type: 'bearer', tokenHint: '…cdef' });
    expect(JSON.stringify(response.body)).not.toContain('tok-abcdef');
  });

  it('POST rejects a destinationAuth that breaks the credential contract', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });

    const rejectedBodies: Array<Record<string, unknown>> = [
      // Unknown type / extra keys under the explicit 'none' clear marker.
      { destinationAuth: { type: 'digest' } },
      { destinationAuth: { type: 'none', token: 'sneaky' } },
      // Required-field mismatches per type.
      { destinationAuth: { type: 'bearer' } },
      { destinationAuth: { type: 'basic', username: 'u' } },
      { destinationAuth: { type: 'apiKey', headerName: 'X-Key' } },
      // Header-name contract (RFC 7230 token) for apiKey.
      { destinationAuth: { type: 'apiKey', headerName: 'X-Bad Name!', value: 'v' } },
      { destinationAuth: { type: 'apiKey', headerName: 'X-Evil\r\nX-Injected', value: 'v' } },
      {
        destinationAuth: {
          type: 'apiKey',
          headerName: 'X'.repeat(DESTINATION_HEADER_NAME_MAX_LENGTH + 1),
          value: 'v',
        },
      },
      // Credential values must be single visible lines of bounded length.
      { destinationAuth: { type: 'bearer', token: 'a\r\nX-Evil: 1' } },
      { destinationAuth: { type: 'bearer', token: '' } },
      { destinationAuth: { type: 'bearer', token: 'x'.repeat(DESTINATION_HEADER_VALUE_MAX_LENGTH + 1) } },
      // Above Latin-1: fetch throws a ByteString conversion at replay, which
      // would surface as a mislabeled 502 instead of a write-time 400.
      { destinationAuth: { type: 'bearer', token: 'tok-日本語' } },
      { destinationAuth: { type: 'apiKey', headerName: 'X-Key', value: 'a\uD800b' } },
      // The literal null is not a type this contract knows.
      { destinationAuth: 42 },
    ];

    for (const extra of rejectedBodies) {
      const response = await request(app.getHttpServer())
        .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
        .set('Authorization', authFor(CALLER_ID))
        .send({ name: 'Stripe', destinationUrl: DESTINATION_URL, ...extra });
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    }
    expect(prismaMock.subscriber.create).not.toHaveBeenCalled();
  });

  it('PATCH { type: "none" } clears a stored credential (writes DbNull)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(
      subscriberRow({ destinationAuth: { type: 'bearer', token: 'tok-abcdef' } }),
    );

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ destinationAuth: { type: 'none' } });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.destination.auth).toEqual({ type: 'none' });
    expect(prismaMock.subscriber.update).toHaveBeenCalledWith({
      where: { id: SUBSCRIBER_ID },
      data: { destinationAuth: Prisma.DbNull },
    });
  });

  it('PATCH replaces a stored credential; the response shows only the new hint', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(
      subscriberRow({ destinationAuth: { type: 'apiKey', headerName: 'X-Legacy-Key', value: 'legacy-value' } }),
    );

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({
        destinationAuth: { type: 'basic', username: 'svc-prod', password: 'p-1234' },
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(prismaMock.subscriber.update).toHaveBeenCalledWith({
      where: { id: SUBSCRIBER_ID },
      data: { destinationAuth: { type: 'basic', username: 'svc-prod', password: 'p-1234' } },
    });
    expect(response.body.data.destination.auth).toEqual({
      type: 'basic',
      usernameHint: '…prod',
    });
    expect(JSON.stringify(response.body)).not.toContain('p-1234');
  });

  it('PATCH absent destinationAuth keeps the stored credential (no write)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(
      subscriberRow({ destinationAuth: { type: 'apiKey', headerName: 'X-Key', value: 'keep-me' } }),
    );

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'Renamed' });

    expect(response.status).toBe(HttpStatus.OK);
    // The key must not appear in the write payload at all.
    const updateData = (
      prismaMock.subscriber.update.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(updateData).toEqual({ name: 'Renamed' });
    // The mock's read-back of the (unchanged) row carries the credential.
    expect(response.body.data.destination.auth).toEqual({
      type: 'apiKey',
      headerName: 'X-Key',
      valueHint: '…p-me',
    });
  });

  it('PATCH null destinationAuth keeps the stored credential (does not wipe)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(
      subscriberRow({ destinationAuth: { type: 'bearer', token: 'keep-this' } }),
    );

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ destinationAuth: null });

    expect(response.status).toBe(HttpStatus.OK);
    // The only sanctioned clear is { type: 'none' }; a JSON null must not wipe.
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();
    expect(response.body.data.destination.auth).toEqual({ type: 'bearer', tokenHint: '…this' });
  });

  it('GET detail masks any stored credential to hints (apiKey shape)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(
      subscriberRow({ destinationAuth: { type: 'apiKey', headerName: 'X-Hook-Key', value: 'value-9876' } }),
    );

    const response = await request(app.getHttpServer())
      .get(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.destination.auth).toEqual({
      type: 'apiKey',
      headerName: 'X-Hook-Key',
      valueHint: '…9876',
    });
    expect(JSON.stringify(response.body)).not.toContain('value-9876');
  });

  it('PATCH answers 404 to a non-member (nothing written)', async () => {
    // The subscriber row exists but the caller has no membership row — the
    // shared assertMember path must hide existence before the write.
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());
    prismaMock.membership.findUnique.mockResolvedValue(null);

    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(STRANGER_ID))
      .send({ name: 'Renamed by a stranger' });

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.error.code).toBe('not_found');
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();
  });

  it('rotate (owner): new secret only, token untouched, lock → swap → window reset in one tx', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.OWNER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    const response = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/rotate`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data).toEqual({
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
      secretHint: expect.stringMatching(/^…[0-9a-f]{4}$/),
      rotatedAt: expect.any(String),
      note: ROTATE_NOTE,
    });
    // C5: rotate carries neither URL nor token — the UI reuses the cached pair.
    expect(response.body.data).not.toHaveProperty('ingestToken');
    expect(response.body.data).not.toHaveProperty('endpointUrl');

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.subscriber.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(updateCall.where).toEqual({ id: SUBSCRIBER_ID });
    // Token unchanged: the swap writes exactly secret + rotatedAt, nothing else.
    expect(Object.keys(updateCall.data).sort()).toEqual(['hmacSecret', 'rotatedAt']);
    expect(updateCall.data.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(updateCall.data.hmacSecret).not.toBe(SECRET);

    expect(prismaMock.rateLimitWindow.deleteMany).toHaveBeenCalledWith({
      where: { subscriberId: SUBSCRIBER_ID },
    });
    // §4.4: advisory lock first, then the swap, then the window reset.
    const lockCall = prismaMock.$executeRaw.mock.calls[0][0] as TemplateStringsArray;
    expect(lockCall.join('')).toContain('pg_advisory_xact_lock');
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.subscriber.update.mock.invocationCallOrder[0],
    );
    expect(prismaMock.subscriber.update.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.rateLimitWindow.deleteMany.mock.invocationCallOrder[0],
    );

    const serialized = JSON.stringify(response.body);
    expect(serialized).toContain('"secret"');
    expect(serialized).not.toContain('hmacSecret');
  });

  it('rotate answers 403 to a member (nothing written) and 404 to a non-member', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    const member = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/rotate`)
      .set('Authorization', authFor(CALLER_ID));

    expect(member.status).toBe(HttpStatus.FORBIDDEN);
    expect(member.body.error.code).toBe('forbidden');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();

    prismaMock.membership.findUnique.mockResolvedValue(null);
    const stranger = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/rotate`)
      .set('Authorization', authFor(STRANGER_ID));

    expect(stranger.status).toBe(HttpStatus.NOT_FOUND);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('revoke (owner): writes revokedAt, returns the note, serializes no secret', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.OWNER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    const response = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/revoke`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data).toEqual({
      revokedAt: expect.any(String),
      note: REVOKE_NOTE,
    });
    // revokedAt written here is what ingest reads to answer 410 later (P3).
    expect(prismaMock.subscriber.update).toHaveBeenCalledWith({
      where: { id: SUBSCRIBER_ID },
      data: { revokedAt: expect.any(Date) },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/"secret"\s*:/);
    expect(serialized).not.toContain('hmacSecret');
  });

  it('revoke is idempotent: a second call keeps the original revokedAt', async () => {
    const original = new Date('2026-05-06T07:08:09.000Z');
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.OWNER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow({ revokedAt: original }));

    const response = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/revoke`)
      .set('Authorization', authFor(CALLER_ID));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.revokedAt).toBe(original.toISOString());
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();
  });

  it('revoke answers 403 to a member and 404 to a non-member', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    const member = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/revoke`)
      .set('Authorization', authFor(CALLER_ID));

    expect(member.status).toBe(HttpStatus.FORBIDDEN);
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();

    prismaMock.membership.findUnique.mockResolvedValue(null);
    const stranger = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/revoke`)
      .set('Authorization', authFor(STRANGER_ID));

    expect(stranger.status).toBe(HttpStatus.NOT_FOUND);
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();
  });

  it('DELETE: owner → 204, member → 403, non-member → 404, non-numeric id → 400', async () => {
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());

    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.OWNER });
    const owner = await request(app.getHttpServer())
      .delete(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));
    expect(owner.status).toBe(HttpStatus.NO_CONTENT);
    expect(owner.text).toBe('');
    expect(prismaMock.subscriber.delete).toHaveBeenCalledWith({
      where: { id: SUBSCRIBER_ID },
    });

    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    const member = await request(app.getHttpServer())
      .delete(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));
    expect(member.status).toBe(HttpStatus.FORBIDDEN);
    expect(member.body.error.code).toBe('forbidden');

    prismaMock.membership.findUnique.mockResolvedValue(null);
    const stranger = await request(app.getHttpServer())
      .delete(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(STRANGER_ID));
    expect(stranger.status).toBe(HttpStatus.NOT_FOUND);
    expect(stranger.body.error.code).toBe('not_found');

    const callsSoFar = prismaMock.subscriber.delete.mock.calls.length;
    const malformed = await request(app.getHttpServer())
      .delete('/api/subscribers/not-a-number')
      .set('Authorization', authFor(CALLER_ID));
    expect(malformed.status).toBe(HttpStatus.BAD_REQUEST);
    expect(prismaMock.subscriber.delete.mock.calls.length).toBe(callsSoFar);
    expect(prismaMock.subscriber.findUnique).toHaveBeenCalledTimes(3);
  });

  it('every route answers 401 without a JWT', async () => {
    const list = await request(app.getHttpServer()).get(
      `/api/workspaces/${WORKSPACE_ID}/subscribers`,
    );
    const detail = await request(app.getHttpServer()).get(`/api/subscribers/${SUBSCRIBER_ID}`);
    const rotate = await request(app.getHttpServer()).post(
      `/api/subscribers/${SUBSCRIBER_ID}/rotate`,
    );

    for (const response of [list, detail, rotate]) {
      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.error.code).toBe('unauthorized');
    }
  });

  it('V-2 audit: list/detail/revoke JSON never contains the secret or hmacSecret', async () => {
    // detail + list read rows that also carry a stored outbound credential —
    // the credential fields must stay out of the wire too (02 §4 masking).
    const credentialed = subscriberRow({
      destinationAuth: { type: 'basic', username: 'svc', password: 'super-secret-pass' },
    });
    prismaMock.subscriber.findUnique.mockResolvedValue(credentialed);
    prismaMock.subscriber.findMany.mockResolvedValue([credentialed]);

    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    const list = await request(app.getHttpServer())
      .get(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID));
    const detail = await request(app.getHttpServer())
      .get(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', authFor(CALLER_ID));

    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.OWNER });
    const revoke = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/revoke`)
      .set('Authorization', authFor(CALLER_ID));

    for (const response of [list, detail, revoke]) {
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/"secret"\s*:/);
      expect(serialized).not.toContain('hmacSecret');
      // The stored credential's secret fields never reach the wire either.
      expect(serialized).not.toContain('super-secret-pass');
      expect(serialized).not.toMatch(/"password"\s*:/);
    }
    // The hint is the sanctioned stand-in on detail payloads — list is a
    // SubscriberSummary (02 §4 wire shape) and carries no secret material at all.
    expect(detail.body.data.secretHint).toBe(`…${SECRET.slice(-4)}`);
    expect(detail.body.data.destination.auth).toEqual({ type: 'basic', usernameHint: '…svc' });

    // The two allowed carriers still carry it — create and rotate only.
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    const create = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', authFor(CALLER_ID))
      .send({ name: 'Stripe', destinationUrl: DESTINATION_URL });
    expect(JSON.stringify(create.body)).toMatch(/"secret"\s*:/);

    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.OWNER });
    const rotate = await request(app.getHttpServer())
      .post(`/api/subscribers/${SUBSCRIBER_ID}/rotate`)
      .set('Authorization', authFor(CALLER_ID));
    expect(JSON.stringify(rotate.body)).toMatch(/"secret"\s*:/);
  });
});

function definedFields<T extends Record<string, unknown>>(data: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function subscriberRow(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id: SUBSCRIBER_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Stripe',
    ingestToken: TOKEN,
    hmacSecret: SECRET,
    destinationMethod: DestinationMethod.POST,
    destinationUrl: DESTINATION_URL,
    destinationHeaders: { 'x-env': 'prod' },
    destinationAuth: null,
    signatureHeaderName: 'X-Hub-Signature-256',
    revokedAt: null,
    rotatedAt: null,
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    ...overrides,
  };
}
