import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RecordStatus } from '../generated/prisma/client';
import { LIST_LIMIT_DEFAULT, MS_PER_DAY, RETENTION_NOTICE } from '../common/constants/app.constants';
import { RETENTION_DAYS } from '../common/constants/ingest.constants';
import { PrismaService } from '../common/prisma/prisma.service';
import { receivedWhere } from '../common/prisma/record-count';
import { decodeCursor, encodeCursor } from './cursor';
import { RecordListItem, RecordListRow, toListItem } from './records.mapper';

export interface ListRecordsOptions {
  status?: RecordStatus;
  q?: string;
  limit?: number;
  cursor?: string;
  offset?: number;
  includeReplays?: boolean;
  /** Workspace route: q also prefixes subscriber ingestToken (02 §5). */
  matchIngestToken?: boolean;
}

export interface RecordListResponse {
  data: RecordListItem[];
  meta: { nextCursor: string | null; hasMore: boolean; total?: number };
}

export interface ReasonBreakdown {
  missing_signature: number;
  invalid_signature: number;
  rate_limited: number;
  body_too_large: number;
}

export interface SubscriberStats {
  subscriberId: number;
  received: number;
  verified: number;
  rejected: number;
  replays: number;
  reasonBreakdown: ReasonBreakdown;
  retention: { days: number; notice: string; oldestKeptAt: string | null };
}

const RECORD_INCLUDE = {
  subscriber: { select: { workspaceId: true, name: true } },
} as const;

const TIMELINE_ORDER: Prisma.WebhookRecordOrderByWithRelationInput[] = [
  { receivedAt: 'desc' },
  { id: 'desc' },
];

@Injectable()
export class RecordsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForSubscriber(subscriberId: number, options: ListRecordsOptions): Promise<RecordListResponse> {
    return this.list({ subscriberId }, options);
  }

  async listForWorkspace(workspaceId: number, options: ListRecordsOptions): Promise<RecordListResponse> {
    return this.list({ subscriber: { workspaceId } }, { ...options, matchIngestToken: true });
  }

  async stats(subscriberId: number): Promise<SubscriberStats> {
    const rejectedScope = receivedWhere({ subscriberId, status: RecordStatus.REJECTED });
    const [received, verified, rejected, replays, grouped, oldest] = await Promise.all([
      this.countReceived({ subscriberId }),
      this.countReceived({ subscriberId, status: RecordStatus.VERIFIED }),
      this.countReceived({ subscriberId, status: RecordStatus.REJECTED }),
      this.prisma.webhookRecord.count({ where: { subscriberId, replayOfId: { not: null } } }),
      this.prisma.webhookRecord.groupBy({
        by: ['rejectReason'],
        where: rejectedScope,
        _count: { _all: true },
      }),
      this.prisma.webhookRecord.findFirst({
        where: receivedWhere({ subscriberId }),
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
    ]);

    const reasonBreakdown: ReasonBreakdown = {
      missing_signature: 0,
      invalid_signature: 0,
      rate_limited: 0,
      body_too_large: 0,
    };
    for (const group of grouped) {
      if (group.rejectReason !== null) {
        reasonBreakdown[group.rejectReason.toLowerCase() as keyof ReasonBreakdown] += group._count._all;
      }
    }

    // 02 §7: floor at now−7d so a subscriber with ancient rows reports the
    // retention horizon the client will actually experience.
    const cutoff = Date.now() - RETENTION_DAYS * MS_PER_DAY;
    const oldestKeptAt =
      oldest === null ? null : new Date(Math.max(cutoff, oldest.receivedAt.getTime())).toISOString();

    return {
      subscriberId,
      received,
      verified,
      rejected,
      replays,
      reasonBreakdown,
      retention: { days: RETENTION_DAYS, notice: RETENTION_NOTICE, oldestKeptAt },
    };
  }

  /** Canonical received-count chokepoint (02 §10) — the only place count() is reached with a scope. */
  async countReceived(scope: Prisma.WebhookRecordWhereInput = {}): Promise<number> {
    return this.prisma.webhookRecord.count({ where: receivedWhere(scope) });
  }

  private async list(
    scope: Prisma.WebhookRecordWhereInput,
    options: ListRecordsOptions,
  ): Promise<RecordListResponse> {
    if (options.cursor !== undefined && options.offset !== undefined) {
      throw new BadRequestException({ message: 'cursor and offset are mutually exclusive' });
    }

    const limit = options.limit ?? LIST_LIMIT_DEFAULT;
    const clauses: Prisma.WebhookRecordWhereInput[] = [
      options.includeReplays === true ? scope : receivedWhere(scope),
    ];
    if (options.status !== undefined) clauses.push({ status: options.status });
    if (options.q !== undefined) clauses.push(this.searchClause(options.q, options.matchIngestToken === true));

    const cursorWhere = this.cursorClause(options.cursor);

    if (options.offset !== undefined) {
      const where: Prisma.WebhookRecordWhereInput = { AND: clauses };
      const [total, rows] = await Promise.all([
        this.prisma.webhookRecord.count({ where }),
        this.prisma.webhookRecord.findMany({
          where,
          orderBy: TIMELINE_ORDER,
          skip: options.offset,
          take: limit,
          include: RECORD_INCLUDE,
        }),
      ]);
      return {
        data: rows.map(toListItem),
        meta: { nextCursor: null, hasMore: options.offset + rows.length < total, total },
      };
    }

    const where: Prisma.WebhookRecordWhereInput =
      cursorWhere === null ? { AND: clauses } : { AND: [...clauses, cursorWhere] };
    // limit+1 probes hasMore without a second count query.
    const rows = await this.prisma.webhookRecord.findMany({
      where,
      orderBy: TIMELINE_ORDER,
      take: limit + 1,
      include: RECORD_INCLUDE,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : (rows as RecordListRow[]);
    const last = page[page.length - 1];
    return {
      data: page.map(toListItem),
      meta: { nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null, hasMore },
    };
  }

  private cursorClause(cursor: string | undefined): Prisma.WebhookRecordWhereInput | null {
    if (cursor === undefined) return null;
    const decoded = decodeCursor(cursor);
    if (decoded === null) throw new BadRequestException({ message: 'invalid cursor' });
    return {
      OR: [{ receivedAt: { lt: decoded.receivedAt } }, { receivedAt: decoded.receivedAt, id: { lt: decoded.id } }],
    };
  }

  private searchClause(q: string, matchIngestToken: boolean): Prisma.WebhookRecordWhereInput {
    const alternatives: Prisma.WebhookRecordWhereInput[] = [
      { eventType: { contains: q, mode: 'insensitive' } },
      { headers: { path: ['x-request-id'], equals: q } },
    ];
    if (matchIngestToken) {
      alternatives.push({ subscriber: { ingestToken: { startsWith: q } } });
    }
    return { OR: alternatives };
  }
}
