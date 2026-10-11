import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { Role } from '../generated/prisma/enums';
import { WorkspacesModule } from './workspaces.module';
import { MembershipModule } from '../common/membership/membership.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JWT_ALGORITHM } from '../auth/auth.constants';

const JWT_SECRET = 'workspaces-api-spec-secret-0123456789';
const MEMBER_ID = 1;
const OTHER_USER_ID = 2;
const WORKSPACE_ID = 7;

describe('workspaces API (02 §3 matrix at the routes)', () => {
  let app: INestApplication;

  const membershipFindUnique = jest.fn();
  const membershipFindMany = jest.fn();
  const membershipCreate = jest.fn();
  const workspaceCreate = jest.fn();
  const workspaceDelete = jest.fn();
  const subscriberFindMany = jest.fn();

  interface PrismaMock {
    membership: { findUnique: jest.Mock; findMany: jest.Mock; create: jest.Mock };
    workspace: { create: jest.Mock; delete: jest.Mock };
    subscriber: { findMany: jest.Mock };
    $transaction: jest.Mock;
  }

  const prismaMock: PrismaMock = {
    membership: {
      findUnique: membershipFindUnique,
      findMany: membershipFindMany,
      create: membershipCreate,
    },
    workspace: { create: workspaceCreate, delete: workspaceDelete },
    subscriber: { findMany: subscriberFindMany },
    $transaction: jest.fn(
      async (fn: (tx: PrismaMock) => Promise<unknown>): Promise<unknown> => fn(prismaMock),
    ),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const moduleRef = await Test.createTestingModule({
      // MembershipModule is @Global() at the app root; this isolated testing
      // module never imports AppModule, so the global registration must be
      // repeated here for WorkspacesService's MembershipService dependency.
      imports: [PrismaModule, MembershipModule, WorkspacesModule],
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
    membershipFindMany.mockResolvedValue([]);
    subscriberFindMany.mockResolvedValue([]);
    membershipFindUnique.mockResolvedValue(null);
  });

  function tokenFor(userId: number): string {
    return sign({ sub: userId, email: `user${userId}@example.com` }, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '1h',
    });
  }

  function ownedMembership(role: Role): unknown {
    return {
      userId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      role,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      workspace: { id: WORKSPACE_ID, name: 'Acme', createdAt: new Date('2026-01-02T03:04:05.000Z') },
    };
  }

  describe('GET /api/workspaces', () => {
    it('lists the caller workspaces with badge counts (owner)', async () => {
      membershipFindMany.mockResolvedValue([ownedMembership(Role.OWNER)]);
      subscriberFindMany.mockResolvedValue([
        { workspaceId: WORKSPACE_ID, _count: { records: 3 } },
        { workspaceId: WORKSPACE_ID, _count: { records: 2 } },
      ]);

      const response = await request(app.getHttpServer())
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({
        data: [
          {
            id: WORKSPACE_ID,
            name: 'Acme',
            role: 'owner',
            subscriberCount: 2,
            receivedCount: 5,
            createdAt: '2026-01-02T03:04:05.000Z',
          },
        ],
      });
      // receivedCount flows through the canonical replayOfId filter (02 §10).
      expect(subscriberFindMany).toHaveBeenCalledWith({
        where: { workspaceId: { in: [WORKSPACE_ID] } },
        select: {
          workspaceId: true,
          _count: { select: { records: { where: { replayOfId: null } } } },
        },
      });
    });

    it('marks memberships the caller does not own as member', async () => {
      membershipFindMany.mockResolvedValue([ownedMembership(Role.MEMBER)]);

      const response = await request(app.getHttpServer())
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.data[0].role).toBe('member');
    });

    it('answers 200 with an empty list when the caller belongs nowhere', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(OTHER_USER_ID)}`);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ data: [] });
      expect(subscriberFindMany).not.toHaveBeenCalled();
    });

    it('answers 401 unauthorized without a token', async () => {
      const response = await request(app.getHttpServer()).get('/api/workspaces');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.error.code).toBe('unauthorized');
    });
  });

  describe('POST /api/workspaces', () => {
    it('creates the workspace and its owner membership in one transaction (201)', async () => {
      workspaceCreate.mockResolvedValue({
        id: WORKSPACE_ID,
        name: 'New Workspace',
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
      });
      membershipCreate.mockResolvedValue({});

      const response = await request(app.getHttpServer())
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`)
        .send({ name: 'New Workspace' });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.data).toEqual({
        id: WORKSPACE_ID,
        name: 'New Workspace',
        role: 'owner',
        subscriberCount: 0,
        receivedCount: 0,
        createdAt: '2026-02-03T04:05:06.000Z',
      });
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(membershipCreate).toHaveBeenCalledWith({
        data: { workspaceId: WORKSPACE_ID, userId: MEMBER_ID, role: Role.OWNER },
      });
    });

    it('rejects a blank or oversized name with 400', async () => {
      const blank = await request(app.getHttpServer())
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`)
        .send({ name: '' });
      const oversized = await request(app.getHttpServer())
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`)
        .send({ name: 'x'.repeat(81) });

      expect(blank.status).toBe(HttpStatus.BAD_REQUEST);
      expect(oversized.status).toBe(HttpStatus.BAD_REQUEST);
      expect(workspaceCreate).not.toHaveBeenCalled();
    });

    it('rejects unknown body fields with 400 (whitelist pipe)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`)
        .send({ name: 'Fine', role: 'owner' });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(workspaceCreate).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/workspaces/:workspaceId — owner/member/non-member', () => {
    it('owner → 204 and the workspace row goes away', async () => {
      membershipFindUnique.mockResolvedValue({ role: Role.OWNER });
      workspaceDelete.mockResolvedValue({});

      const response = await request(app.getHttpServer())
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`);

      expect(response.status).toBe(HttpStatus.NO_CONTENT);
      expect(response.text).toBe('');
      expect(workspaceDelete).toHaveBeenCalledWith({ where: { id: WORKSPACE_ID } });
    });

    it('member → 403 forbidden, nothing deleted', async () => {
      membershipFindUnique.mockResolvedValue({ role: Role.MEMBER });

      const response = await request(app.getHttpServer())
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body.error.code).toBe('forbidden');
      expect(workspaceDelete).not.toHaveBeenCalled();
    });

    it('non-member → 404 not_found, nothing deleted (existence never leaks)', async () => {
      membershipFindUnique.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set('Authorization', `Bearer ${tokenFor(OTHER_USER_ID)}`);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(response.body.error.code).toBe('not_found');
      expect(workspaceDelete).not.toHaveBeenCalled();
    });

    it('non-numeric id → 400 (ParseIntPipe) before any lookup', async () => {
      const response = await request(app.getHttpServer())
        .delete('/api/workspaces/not-a-number')
        .set('Authorization', `Bearer ${tokenFor(MEMBER_ID)}`);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(membershipFindUnique).not.toHaveBeenCalled();
      expect(workspaceDelete).not.toHaveBeenCalled();
    });
  });
});
