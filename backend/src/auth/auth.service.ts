import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { sign } from 'jsonwebtoken';
import { PrismaService } from '../common/prisma/prisma.service';
import { BCRYPT_COST, JWT_TTL } from '../common/constants/app.constants';
import {
  INVALID_CREDENTIALS_MESSAGE,
  JWT_ALGORITHM,
  TIMING_DECOY_PASSWORD_HASH,
  TOKEN_TYPE,
} from './auth.constants';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponse, AuthUser, JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Duplicate email surfaces as Prisma P2002 and propagates untouched —
   * the one global filter maps it to 409 `email_taken` (BUILD_PLAN P1).
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = normalizeEmail(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const user = await this.prisma.user.create({ data: { email, passwordHash } });
    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Pay the same bcrypt cost as the wrong-password branch so the two
      // failures are identical in body AND in timing (no user enumeration).
      await bcrypt.compare(dto.password, TIMING_DECOY_PASSWORD_HASH);
      throw invalidCredentials();
    }
    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      throw invalidCredentials();
    }
    return this.buildAuthResponse(user);
  }

  /** Fresh read: a token issued before an account was deleted must not resolve. */
  async getMe(userId: number): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // Deleted account — the credential no longer identifies a principal,
      // so this is the same 401 the guard emits, not a 404 (02 §2: 200 | 401).
      throw new UnauthorizedException({ message: 'invalid token' });
    }
    return toAuthUser(user);
  }

  private buildAuthResponse(user: {
    id: number;
    email: string;
    passwordHash: string;
    createdAt: Date;
  }): AuthResponse {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    const accessToken = sign(payload, requiredJwtSecret(), {
      algorithm: JWT_ALGORITHM,
      expiresIn: JWT_TTL,
    });
    return { accessToken, tokenType: TOKEN_TYPE, user: toAuthUser(user) };
  }
}

function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({ message: INVALID_CREDENTIALS_MESSAGE });
}

function toAuthUser(user: { id: number; email: string; createdAt: Date }): AuthUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

/**
 * main.ts validates JWT_SECRET before Nest boots and specs set it themselves;
 * a hard failure here beats signing tokens with an empty secret (500, not 401).
 */
function requiredJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}
