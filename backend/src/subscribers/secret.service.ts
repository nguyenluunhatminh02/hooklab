import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { TOKEN_BYTES } from '../common/constants/app.constants';
import { PrismaService } from '../common/prisma/prisma.service';
import { SECRET_HINT_ELLIPSIS, SECRET_HINT_LENGTH } from './subscribers.constants';

export interface RotatedSecret {
  secret: string;
  secretHint: string;
  rotatedAt: Date;
}

/**
 * Owns every generated credential the subscriber has: the public ingest token
 * and the HMAC secret (both TOKEN_BYTES of entropy as hex — SPEC). Rotate
 * lives here because the swap must stay atomic with the rate-limit reset.
 */
@Injectable()
export class SecretService {
  constructor(private readonly prisma: PrismaService) {}

  generate(): string {
    return randomBytes(TOKEN_BYTES).toString('hex');
  }

  /** 02 §4 "…cdef": last 4 chars — the only secret form safe to serialize. */
  hint(secret: string): string {
    return `${SECRET_HINT_ELLIPSIS}${secret.slice(-SECRET_HINT_LENGTH)}`;
  }

  /**
   * BUILD_PLAN §7 P2 / 03 §4.4 rotate — ONE callback-style transaction:
   * advisory lock → swap hmacSecret → clear the sliding window, in that order.
   *
   * Why this order matters: ingest capture takes the same
   * `pg_advisory_xact_lock(<subscriberId>)` before reading the secret, so
   * every in-flight verify drains before the swap commits and every capture
   * that reaches the lock afterwards reads the new secret — an old secret can
   * never verify once this resolves. The window reset rides the same
   * transaction because a rotate during a 429 ban would otherwise hand out a
   * secret that is still banned (02 §4 rotate semantics).
   */
  async rotate(subscriberId: number): Promise<RotatedSecret> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${subscriberId}::bigint)`;
      const secret = this.generate();
      const rotatedAt = new Date();
      await tx.subscriber.update({
        where: { id: subscriberId },
        data: { hmacSecret: secret, rotatedAt },
      });
      await tx.rateLimitWindow.deleteMany({ where: { subscriberId } });
      return { secret, secretHint: this.hint(secret), rotatedAt };
    });
  }
}
