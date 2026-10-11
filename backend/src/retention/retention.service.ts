import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MS_PER_DAY } from '../common/constants/app.constants';
import { RATE_LIMIT_WINDOW_MS, RETENTION_DAYS } from '../common/constants/ingest.constants';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  RETENTION_CRON_EXPRESSION,
  RETENTION_CRON_NAME,
  RETENTION_CRON_TIME_ZONE,
} from './retention.constants';

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(RETENTION_CRON_EXPRESSION, {
    name: RETENTION_CRON_NAME,
    timeZone: RETENTION_CRON_TIME_ZONE,
  })
  async purgeExpiredRecords(): Promise<void> {
    // RateLimitWindow.occurredAt and webhook receivedAt are stamped by
    // PostgreSQL, and RateLimitService computes its cutoff from PostgreSQL's
    // clock — take the sweep cutoff from that same clock, so app/DB skew can
    // neither delete rows the limiter still counts nor strand expired ones.
    const [{ dbNow }] = await this.prisma.$queryRaw<Array<{ dbNow: Date }>>`
      SELECT now() AS "dbNow"
    `;
    const now = dbNow.getTime();
    const { count } = await this.prisma.webhookRecord.deleteMany({
      where: { receivedAt: { lt: new Date(now - RETENTION_DAYS * MS_PER_DAY) } },
    });
    this.logger.log(`retention: deleted ${count} records older than ${RETENTION_DAYS}d`);

    // C13: the replayOfId FK cascade only fires when a parent record is deleted;
    // time-expired RateLimitWindow rows are covered by no cascade (their FK
    // points at Subscriber), so the sweep prunes them explicitly — same job,
    // no second cron. The logged `count` stays the parent-row number SPEC asks
    // for: cascaded replay children are not part of deleteMany's return value.
    await this.prisma.rateLimitWindow.deleteMany({
      where: { occurredAt: { lt: new Date(now - RATE_LIMIT_WINDOW_MS) } },
    });
  }
}
