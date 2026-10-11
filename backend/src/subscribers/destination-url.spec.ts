// SubscribersService re-validates env at construction (single source of truth
// with main.ts), and the full Joi gate includes DATABASE_URL — load .env here
// the same way rotate-race.spec does, before the testing module compiles.
import 'dotenv/config';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { Role } from '../generated/prisma/enums';
import type { Subscriber } from '../generated/prisma/client';
import { DestinationMethod } from '../generated/prisma/enums';
import { SubscribersModule } from './subscribers.module';
import { MembershipModule } from '../common/membership/membership.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JWT_ALGORITHM } from '../auth/auth.constants';
import { isSafeDestinationUrl } from './subscribers.constraints';

const JWT_SECRET = 'destination-url-spec-secret-0123456789';
const CALLER_ID = 1;
const WORKSPACE_ID = 7;
const SUBSCRIBER_ID = 11;
const TOKEN = 'c0ffee00'.repeat(8);
const SECRET = '1234567890abcdef'.repeat(4);

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

const REJECTED_URLS: Array<[string, string]> = [
  ['file:// URL', 'file:///etc/passwd'],
  ['ftp:// URL', 'ftp://files.example.test/hook'],
  ['scheme-less URL', 'hooks.example.test/hook'],
  ['credential-bearing URL', 'http://user:pass@hooks.example.test/hook'],
];

const ACCEPTED_URLS: string[] = [
  'http://hooks.example.test/hook',
  'https://hooks.example.test/hook',
  'http://localhost:3000/webhooks',
];

describe('destination URL contract (02 §4)', () => {
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
    process.env.PUBLIC_BASE_URL = 'http://hooklab.test';
    process.env.JWT_SECRET = JWT_SECRET;
    const moduleRef = await Test.createTestingModule({
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
    prismaMock.membership.findUnique.mockResolvedValue({ role: Role.MEMBER });
    prismaMock.subscriber.findUnique.mockResolvedValue(subscriberRow());
    prismaMock.subscriber.create.mockImplementation(
      async ({ data }: { data: Partial<Subscriber> }) => subscriberRow({ ...data }),
    );
    prismaMock.subscriber.update.mockImplementation(
      async ({ where, data }: { where: { id: number }; data: Partial<Subscriber> }) =>
        subscriberRow({ ...definedFields(data), id: where.id }),
    );
    prismaMock.webhookRecord.groupBy.mockResolvedValue([]);
    prismaMock.rateLimitWindow.deleteMany.mockResolvedValue({ count: 0 });
  });

  function auth(): string {
    const token = sign({ sub: CALLER_ID, email: 'user1@example.com' }, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '1h',
    });
    return `Bearer ${token}`;
  }

  it.each(REJECTED_URLS)('POST rejects a %s with 400 before touching the store', async (
    _label,
    destinationUrl,
  ) => {
    const response = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', auth())
      .send({ name: 'Stripe', destinationUrl });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    // 02 §1.2/§1.4: 400 carries the validation_error code, never a bare status.
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.message).not.toBe('');
    expect(prismaMock.subscriber.create).not.toHaveBeenCalled();
  });

  it.each(REJECTED_URLS)('PATCH rejects a %s with 400 before touching the store', async (
    _label,
    destinationUrl,
  ) => {
    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', auth())
      .send({ destinationUrl });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    // 02 §1.2/§1.4: 400 carries the validation_error code, never a bare status.
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.message).not.toBe('');
    expect(prismaMock.subscriber.update).not.toHaveBeenCalled();
  });

  it.each(ACCEPTED_URLS)('POST accepts %s with 201', async (destinationUrl) => {
    const response = await request(app.getHttpServer())
      .post(`/api/workspaces/${WORKSPACE_ID}/subscribers`)
      .set('Authorization', auth())
      .send({ name: 'Stripe', destinationUrl });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body.data.destination.url).toBe(destinationUrl);
    expect(prismaMock.subscriber.create).toHaveBeenCalledTimes(1);
  });

  it.each(ACCEPTED_URLS)('PATCH accepts %s with 200', async (destinationUrl) => {
    const response = await request(app.getHttpServer())
      .patch(`/api/subscribers/${SUBSCRIBER_ID}`)
      .set('Authorization', auth())
      .send({ destinationUrl });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data.destination.url).toBe(destinationUrl);
    expect(prismaMock.subscriber.update).toHaveBeenCalledTimes(1);
  });

  describe('isSafeDestinationUrl (unit)', () => {
    it.each(ACCEPTED_URLS)('accepts %s', (value) => {
      expect(isSafeDestinationUrl(value)).toBe(true);
    });

    it.each(REJECTED_URLS)('rejects a %s', (_label, value) => {
      expect(isSafeDestinationUrl(value)).toBe(false);
    });

    it('rejects non-strings and empty hosts', () => {
      expect(isSafeDestinationUrl(null)).toBe(false);
      expect(isSafeDestinationUrl(42)).toBe(false);
      expect(isSafeDestinationUrl('https://')).toBe(false);
      expect(isSafeDestinationUrl('javascript:alert(1)')).toBe(false);
    });
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
    destinationUrl: 'https://hooks.example.test/stripe',
    destinationHeaders: {},
    destinationAuth: null,
    signatureHeaderName: 'X-Hub-Signature-256',
    revokedAt: null,
    rotatedAt: null,
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    ...overrides,
  };
}
