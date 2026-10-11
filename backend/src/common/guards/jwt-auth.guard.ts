import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

const TOKEN_REJECTED_MESSAGE = 'invalid or missing access token';

/**
 * Global auth guard with @Public() opt-out (BUILD_PLAN §3.1).
 * Routes without @Public() must carry an HS256 JWT verified by JwtStrategy.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    try {
      const allowed = await super.canActivate(context);
      // The passport mixin implements canActivate as `async` (resolves `true`
      // or rejects); the declared CanActivate union still lists Observable,
      // which this path cannot produce.
      return allowed as boolean;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        // The stock `new UnauthorizedException()` body carries no `code`, so the
        // global filter could not label it `unauthorized` (02 §1.4) — rethrow
        // with the message the envelope contract expects.
        throw new UnauthorizedException({ message: TOKEN_REJECTED_MESSAGE });
      }
      throw error;
    }
  }
}
