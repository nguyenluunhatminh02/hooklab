import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { BCRYPT_COST } from '../common/constants/app.constants';
import { AuthService } from './auth.service';
import { INVALID_CREDENTIALS_MESSAGE, TIMING_DECOY_PASSWORD_HASH } from './auth.constants';

const JWT_SECRET = 'auth-service-spec-secret-0123456789';
const KNOWN_PASSWORD = 'hooklab-timing-equalizer';

describe('AuthService', () => {
  let service: AuthService;
  const userCreate = jest.fn();
  const userFindUnique = jest.fn();

  const storedUser = {
    id: 1,
    email: 'ada@example.com',
    passwordHash: TIMING_DECOY_PASSWORD_HASH,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  };

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  beforeEach(async () => {
    userCreate.mockReset();
    userFindUnique.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: { user: { create: userCreate, findUnique: userFindUnique } },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('register normalizes email and hashes with the BCRYPT_COST constant', async () => {
    userCreate.mockImplementation(async ({ data }: { data: { email: string; passwordHash: string } }) => ({
      id: 1,
      ...data,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    }));

    const response = await service.register({ email: 'Ada@Example.COM', password: 'correct-horse-1' });

    const persisted = userCreate.mock.calls[0][0] as { data: { email: string; passwordHash: string } };
    expect(persisted.data.email).toBe('ada@example.com');
    expect(persisted.data.passwordHash).not.toBe('correct-horse-1');
    expect(persisted.data.passwordHash).toContain(`$${BCRYPT_COST}$`);
    expect(response.user.email).toBe('ada@example.com');
    expect(response.tokenType).toBe('Bearer');
  });

  it('register propagates P2002 untouched — the global filter owns the 409 mapping', async () => {
    const prismaError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    userCreate.mockRejectedValue(prismaError);

    await expect(service.register({ email: 'ada@example.com', password: 'correct-horse-1' })).rejects.toBe(
      prismaError,
    );
  });

  it('login rejects unknown email and wrong password with the identical body', async () => {
    userFindUnique.mockResolvedValueOnce(null); // unknown email
    userFindUnique.mockResolvedValueOnce(storedUser); // known email, wrong password

    const unknownEmail = await service
      .login({ email: 'ghost@example.com', password: 'not-the-password' })
      .catch((error: unknown) => error);
    const wrongPassword = await service
      .login({ email: storedUser.email, password: 'not-the-password' })
      .catch((error: unknown) => error);

    expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
    expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
    expect((unknownEmail as UnauthorizedException).getResponse()).toEqual(
      (wrongPassword as UnauthorizedException).getResponse(),
    );
    expect((wrongPassword as UnauthorizedException).getResponse()).toEqual({
      message: INVALID_CREDENTIALS_MESSAGE,
    });
  });

  it('login returns a signed token for the right password', async () => {
    userFindUnique.mockResolvedValue(storedUser);

    const response = await service.login({ email: storedUser.email, password: KNOWN_PASSWORD });

    expect(response.accessToken).toEqual(expect.any(String));
    expect(response.user.id).toBe(storedUser.id);
  });
});
