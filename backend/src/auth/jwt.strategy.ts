import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser, JwtPayload } from './auth.types';
import { JWT_ALGORITHM } from './auth.constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // L-3 audit: without `algorithms` a forged token signed `none`/HS512
      // would be accepted whenever the library's defaults change.
      algorithms: [JWT_ALGORITHM],
      secretOrKey: requiredSecret(),
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (typeof payload.sub !== 'number' || typeof payload.email !== 'string') {
      throw new UnauthorizedException({ message: 'invalid token' });
    }
    return { userId: payload.sub, email: payload.email };
  }
}

function requiredSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}
