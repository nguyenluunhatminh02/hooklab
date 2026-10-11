import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { sign, verify } from 'jsonwebtoken';
import { Prisma } from '../generated/prisma/client';
import { AuthModule } from './auth.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BCRYPT_COST, MS_PER_DAY } from '../common/constants/app.constants';
import { INVALID_CREDENTIALS_MESSAGE, JWT_ALGORITHM } from './auth.constants';
import { JwtPayload } from './auth.types';

const JWT_SECRET = 'auth-api-spec-secret-0123456789abcdef0123456789';
const REGISTER_BODY = { email: 'ada@example.com', password: 'correct-horse-1' };

interface StoredUser {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

describe('auth API (register/login/me)', () => {
  let app: INestApplication;
  const users = new Map<string, StoredUser>();
  let nextUserId = 1;

  const userCreate = jest.fn(
    async ({ data }: { data: { email: string; passwordHash: string } }): Promise<StoredUser> => {
      const existing = users.get(data.email);
      if (existing) {
        // Verbatim shape Prisma 7 + @prisma/adapter-pg emits for `User_email_key`
        // (captured live from the real client — there is NO `meta.target` on the
        // driver-adapter path). The filter must read the constraint from here and
        // still answer 409 email_taken.
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`email`)',
          {
            code: 'P2002',
            clientVersion: '7.10.0',
            meta: {
              modelName: 'User',
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  originalCode: '23505',
                  originalMessage:
                    'duplicate key value violates unique constraint "User_email_key"',
                  kind: 'UniqueConstraintViolation',
                  constraint: { index: 'User_email_key' },
                  table: 'User',
                },
              },
            },
          },
        );
      }
      const user: StoredUser = {
        id: nextUserId++,
        email: data.email,
        passwordHash: data.passwordHash,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
      };
      users.set(user.email, user);
      return user;
    },
  );

  const userFindUnique = jest.fn(
    async ({ where }: { where: { id?: number; email?: string } }): Promise<StoredUser | null> => {
      if (where.email !== undefined) {
        return users.get(where.email) ?? null;
      }
      for (const user of users.values()) {
        if (user.id === where.id) {
          return user;
        }
      }
      return null;
    },
  );

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, AuthModule],
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
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ user: { create: userCreate, findUnique: userFindUnique } })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    users.clear();
    nextUserId = 1;
    userCreate.mockClear();
    userFindUnique.mockClear();
  });

  it('POST register answers 201 with a bare AuthResponse and a 12h HS256 token', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/register').send({
      email: 'Ada@Example.COM',
      password: 'correct-horse-1',
    });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body.data).toBeUndefined(); // bare — the §1.2 envelope exception
    expect(response.body.tokenType).toBe('Bearer');
    expect(response.body.user).toEqual({
      id: 1,
      email: 'ada@example.com',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(response.body.accessToken).toEqual(expect.any(String));

    const claims = verify(response.body.accessToken as string, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
    }) as unknown as JwtPayload & { iat?: number; exp?: number };
    expect(claims.sub).toBe(1);
    expect(claims.email).toBe('ada@example.com');
    // JWT_TTL ('12h') is the only source of the lifetime — MS_PER_DAY/2 pins it.
    const lifetimeMs = ((claims.exp ?? 0) - (claims.iat ?? 0)) * 1000;
    expect(lifetimeMs).toBe(MS_PER_DAY / 2);
  });

  it('POST register twice maps Prisma P2002 to 409 email_taken via the global filter', async () => {
    await request(app.getHttpServer()).post('/api/auth/register').send(REGISTER_BODY).expect(HttpStatus.CREATED);

    const duplicate = await request(app.getHttpServer()).post('/api/auth/register').send(REGISTER_BODY);

    expect(duplicate.status).toBe(HttpStatus.CONFLICT);
    expect(duplicate.body.error.code).toBe('email_taken');
    expect(duplicate.body.error.requestId).toEqual(expect.any(String));
    expect(userCreate).toHaveBeenCalledTimes(2); // the service does not pre-check the email
  });

  it('POST register rejects a malformed body with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'short' });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('POST login answers 200 and the token unlocks GET /me', async () => {
    await request(app.getHttpServer()).post('/api/auth/register').send(REGISTER_BODY).expect(HttpStatus.CREATED);

    const login = await request(app.getHttpServer()).post('/api/auth/login').send(REGISTER_BODY);
    expect(login.status).toBe(HttpStatus.OK);
    expect(login.body.data).toBeUndefined(); // bare too

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`);
    expect(me.status).toBe(HttpStatus.OK);
    expect(me.body.data).toEqual({
      id: 1,
      email: 'ada@example.com',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('login failures are indistinguishable — unknown email vs wrong password', async () => {
    await request(app.getHttpServer()).post('/api/auth/register').send(REGISTER_BODY).expect(HttpStatus.CREATED);

    const wrongPassword = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: REGISTER_BODY.email, password: 'wrong-password-1' });
    const unknownEmail = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'wrong-password-1' });

    expect(wrongPassword.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(unknownEmail.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(redactRequestId(unknownEmail.body)).toEqual(redactRequestId(wrongPassword.body));
    expect(wrongPassword.body.error.code).toBe('unauthorized');
    expect(wrongPassword.body.error.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    // Password never lands in the error surface either way.
    expect(JSON.stringify(wrongPassword.body)).not.toContain('wrong-password-1');
  });

  it('GET /me without a token answers 401 unauthorized', async () => {
    const response = await request(app.getHttpServer()).get('/api/auth/me');

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('L-3: a token signed HS512 with the right secret is rejected (algorithm pinned)', async () => {
    const forged = sign({ sub: 1, email: REGISTER_BODY.email }, JWT_SECRET, {
      algorithm: 'HS512',
      expiresIn: '1h',
    });

    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('GET /me with a token for a deleted account answers 401, not 404', async () => {
    const orphan = sign({ sub: 999, email: 'gone@example.com' }, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '1h',
    });

    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${orphan}`);

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('hashes passwords at the BCRYPT_COST constant end to end', async () => {
    await request(app.getHttpServer()).post('/api/auth/register').send(REGISTER_BODY).expect(HttpStatus.CREATED);

    const stored = users.get(REGISTER_BODY.email);
    expect(stored?.passwordHash).toContain(`$${BCRYPT_COST}$`);
    expect(stored?.passwordHash).not.toBe(REGISTER_BODY.password);
  });
});

function redactRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const envelope = body as { error: Record<string, unknown> };
  return { ...body, error: { ...envelope.error, requestId: '<redacted>' } };
}
