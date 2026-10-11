import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { Role } from '../generated/prisma/enums';
import { RecordStatus } from '../generated/prisma/client';
import { RecordsModule } from './records.module';
import { RecordsRepository, type RecordListResponse, type SubscriberStats } from './records.repository';
import { MembershipModule } from '../common/membership/membership.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JWT_ALGORITHM } from '../auth/auth.constants';

const JWT_SECRET = 'records-api-spec-secret-0123456789';
const MEMBER_ID = 1;
const WORKSPACE_ID = 7;
const SUBSCRIBER_ID = 5;
const RECORD_ID = 11;

// The routes under test: every records error branch the audit found untested —
// subscriber-not-found (service :71), record-not-found (:56), the membership
// 404s behind each, the ParseIntPipe 400s, and the ListRecordsQueryDto bounds.
describe('records API (02 §5 routes)', () => {
  let app: INestApplication;

  const membershipFindUnique = jest.fn();
  const subscriberFindUnique = jest.fn();
  const webhookRecordFindUnique = jest.fn();
  const listForSubscriber = jest.fn();
  const listForWorkspace = jest.fn();
  const stats = jest.fn();

  const emptyList: RecordListResponse = { data: [], meta: { nextCursor: null, hasMore: false } };
  const emptyStats: SubscriberStats = {
    subscriberId: SUBSCRIBER_ID,
    received: 0,
    verified: 0,
    rejected: 0,
    replays: 0,
    reasonBreakdown: { missing_signature: 0, invalid_signature: 0, rate_limited: 0, body_too_large: 0 },
    retention: { days: 7, notice: '', oldestKeptAt: null },
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const moduleRef = await Test.createTestingModule({
      // RecordsModule reads MembershipService from the app-root @Global()
      // registration; this isolated module never imports AppModule, so the
      // global registration is repeated here (same reason as workspaces.api).
      imports: [PrismaModule, MembershipModule, RecordsModule],
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
        // AuthModule owns JwtStrategy's usual passport registration and is not
        // imported here; without it the guard above fails every request.
        JwtStrategy,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        membership: { findUnique: membershipFindUnique },
        subscriber: { findUnique: subscriberFindUnique },
        webhookRecord: { findUnique: webhookRecordFindUnique },
      })
      // The list/stats SQL is covered against real PG in records.repository.spec;
      // this spec pins the HTTP layer (status codes, envelope, option mapping).
      .overrideProvider(RecordsRepository)
      .useValue({ listForSubscriber, listForWorkspace, stats })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    membershipFindUnique.mockResolvedValue({ role: Role.MEMBER });
    subscriberFindUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    webhookRecordFindUnique.mockResolvedValue(null);
    listForSubscriber.mockResolvedValue(emptyList);
    listForWorkspace.mockResolvedValue(emptyList);
    stats.mockResolvedValue(emptyStats);
  });

  function tokenFor(userId: number): string {
    return sign({ sub: userId, email: `user${userId}@example.com` }, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '1h',
    });
  }

  function authHeader(userId = MEMBER_ID): Record<string, string> {
    return { Authorization: `Bearer ${tokenFor(userId)}` };
  }

  describe('GET /api/workspaces/:workspaceId/records', () => {
    it('lists for a member and maps wire query params to repository options', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/workspaces/${WORKSPACE_ID}/records?status=verified&q=pay&limit=10&offset=0&includeReplays=true`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual(emptyList);
      expect(listForWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, {
        status: RecordStatus.VERIFIED,
        q: 'pay',
        limit: 10,
        cursor: undefined,
        offset: 0,
        includeReplays: true,
      });
    });

    it('applies defaults when no query params are sent', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/workspaces/${WORKSPACE_ID}/records`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.OK);
      expect(listForWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, {
        status: undefined,
        q: undefined,
        limit: undefined,
        cursor: undefined,
        offset: undefined,
        includeReplays: false,
      });
    });

    it('answers 404 workspace not found for a non-member (never 403 — 02 §3)', async () => {
      membershipFindUnique.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .get(`/api/workspaces/${WORKSPACE_ID}/records`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.code).toBe('not_found');
      expect(response.body.error.message).toBe('workspace not found');
      expect(response.body.error.requestId).toEqual(expect.any(String));
      expect(listForWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/subscribers/:subscriberId/records', () => {
    it('lists for a member of the subscriber workspace', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/subscribers/${SUBSCRIBER_ID}/records`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual(emptyList);
      expect(subscriberFindUnique).toHaveBeenCalledWith({
        where: { id: SUBSCRIBER_ID },
        select: { workspaceId: true },
      });
      expect(listForSubscriber).toHaveBeenCalledWith(SUBSCRIBER_ID, expect.anything());
    });

    it('answers 404 subscriber not found when the id does not exist (service :71)', async () => {
      subscriberFindUnique.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .get(`/api/subscribers/${SUBSCRIBER_ID}/records`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.code).toBe('not_found');
      expect(response.body.error.message).toBe('subscriber not found');
      expect(listForSubscriber).not.toHaveBeenCalled();
    });

    it('answers 404 workspace not found when the caller is not a member', async () => {
      membershipFindUnique.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .get(`/api/subscribers/${SUBSCRIBER_ID}/records`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.message).toBe('workspace not found');
      expect(listForSubscriber).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/records/:recordId', () => {
    const detailRow = {
      id: RECORD_ID,
      subscriberId: SUBSCRIBER_ID,
      method: 'POST',
      url: 'https://example.com/hook',
      headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
      rawBody: '{"action":"opened"}',
      status: RecordStatus.VERIFIED,
      rejectReason: null,
      eventType: 'push',
      bodyBytes: 21,
      replayOfId: null,
      replayTargetUrl: null,
      responseStatus: null,
      responseBody: null,
      replayError: null,
      replayedAt: null,
      durationMs: null,
      receivedAt: new Date('2026-10-01T00:00:00.000Z'),
      subscriber: {
        workspaceId: WORKSPACE_ID,
        name: 'sub-a',
        destinationMethod: 'POST',
        destinationUrl: 'https://example.com/hook',
        destinationHeaders: { Authorization: 'Bearer x' },
      },
      replays: [],
    };

    it('returns the mapped detail for a member (real mapper, live destination)', async () => {
      webhookRecordFindUnique.mockResolvedValue(detailRow);

      const response = await request(app.getHttpServer())
        .get(`/api/records/${RECORD_ID}`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.data).toEqual({
        id: RECORD_ID,
        subscriberId: SUBSCRIBER_ID,
        workspaceId: WORKSPACE_ID,
        subscriberName: 'sub-a',
        status: 'verified',
        reason: null,
        eventType: 'push',
        method: 'POST',
        bodyBytes: 21,
        isReplay: false,
        replayOfId: null,
        replayResponseStatus: null,
        receivedAt: '2026-10-01T00:00:00.000Z',
        url: 'https://example.com/hook',
        headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
        rawBody: '{"action":"opened"}',
        bodyParsed: { action: 'opened' },
        destination: {
          method: 'POST',
          url: 'https://example.com/hook',
          headers: { Authorization: 'Bearer x' },
        },
        replays: [],
      });
      // The record is loaded with its subscriber join for the membership check.
      expect(webhookRecordFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RECORD_ID } }),
      );
    });

    it('answers 404 not_found when the record does not exist (service :56)', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/records/${RECORD_ID}`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.code).toBe('not_found');
      // The service's explicit message survives the envelope; only a raw
      // P2025 (deleted mid-flight) falls back to the generic 'resource not found'.
      expect(response.body.error.message).toBe('record not found');
    });

    it('answers 404 workspace not found when the caller is outside the record workspace', async () => {
      webhookRecordFindUnique.mockResolvedValue(detailRow);
      membershipFindUnique.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .get(`/api/records/${RECORD_ID}`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.message).toBe('workspace not found');
    });

    it('answers 400 validation_error for a non-numeric id (ParseIntPipe)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/records/not-a-number')
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error.code).toBe('validation_error');
      expect(webhookRecordFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/subscribers/:subscriberId/stats', () => {
    it('returns the repository stats for a member', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/subscribers/${SUBSCRIBER_ID}/stats`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.data).toEqual(emptyStats);
      expect(stats).toHaveBeenCalledWith(SUBSCRIBER_ID);
    });

    it('answers 404 subscriber not found when the id does not exist', async () => {
      subscriberFindUnique.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .get(`/api/subscribers/${SUBSCRIBER_ID}/stats`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.message).toBe('subscriber not found');
      expect(stats).not.toHaveBeenCalled();
    });
  });

  describe('query validation (whitelist + bounds)', () => {
    it.each([
      ['limit below the floor', 'limit=0'],
      ['limit above LIST_LIMIT_MAX', 'limit=101'],
      ['non-numeric limit', 'limit=abc'],
      ['negative offset', 'offset=-1'],
      ['unknown status value', 'status=pending'],
      ['q over SEARCH_QUERY_MAX_LENGTH', `q=${'x'.repeat(201)}`],
      ['unknown query param (whitelist)', 'bogus=1'],
    ])('answers 400 validation_error for %s', async (_label, query) => {
      const response = await request(app.getHttpServer())
        .get(`/api/subscribers/${SUBSCRIBER_ID}/records?${query}`)
        .set(authHeader());

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error.code).toBe('validation_error');
      expect(listForSubscriber).not.toHaveBeenCalled();
    });

    it('answers 401 without a token', async () => {
      const response = await request(app.getHttpServer()).get(
        `/api/subscribers/${SUBSCRIBER_ID}/records`,
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.error.code).toBe('unauthorized');
      expect(listForSubscriber).not.toHaveBeenCalled();
    });
  });
});
