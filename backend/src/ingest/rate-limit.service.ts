import { Injectable } from '@nestjs/common';
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../common/constants/ingest.constants';
import { PrismaService } from '../common/prisma/prisma.service';

export type RateDecision = { admitted: true } | { admitted: false; retryAfterSeconds: number };

@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sliding-window admission (BUILD_PLAN §4.4). One transaction takes
   * `pg_advisory_xact_lock(subscriberId)` so concurrent ingest and rotate on
   * the same subscriber serialize on a single key; the window is read with
   * PostgreSQL's clock (never the app's), and only an ADMITTED request writes
   * a window row — a 429 must not count against the window it was refused by.
   */
  async acquire(subscriberId: number): Promise<RateDecision> {
    return this.prisma.$transaction<RateDecision>(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${subscriberId}::bigint)`;

      const [clock] = await tx.$queryRaw<Array<{ dbNow: Date }>>`SELECT now() AS "dbNow"`;
      // Strict `>`: a row exactly RATE_LIMIT_WINDOW_MS old is already outside
      // the window (boundary rule, §8.2 spec).
      const cutoff = new Date(clock.dbNow.getTime() - RATE_LIMIT_WINDOW_MS);
      const windowRows = await tx.rateLimitWindow.findMany({
        where: { subscriberId, occurredAt: { gt: cutoff } },
        select: { occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      });

      if (windowRows.length < RATE_LIMIT_MAX) {
        await tx.rateLimitWindow.create({ data: { subscriberId } });
        return { admitted: true };
      }

      // Retry-After = whole seconds until the oldest admitted row expires,
      // re-read from PostgreSQL at rejection time, clamped to ≥1 (RFC 9110
      // requires a non-zero delay; the ceil lands on 0 as the window rolls).
      const [respondClock] = await tx.$queryRaw<Array<{ dbNow: Date }>>`SELECT now() AS "dbNow"`;
      const oldest = windowRows[0].occurredAt;
      const msLeft = oldest.getTime() + RATE_LIMIT_WINDOW_MS - respondClock.dbNow.getTime();
      return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)) };
    });
  }
}
