import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Subscriber } from '../generated/prisma/client';
import { DestinationMethod, RecordStatus } from '../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import { receivedWhere } from '../common/prisma/record-count';
import { MembershipService } from '../common/membership/membership.service';
import { DEFAULT_SIGNATURE_HEADER } from '../common/constants/ingest.constants';
import { validateEnv } from '../config/env.validation';
import { CreateSubscriberDto } from './dto/create-subscriber.dto';
import { UpdateSubscriberDto } from './dto/update-subscriber.dto';
import { SecretService } from './secret.service';
import {
  DestinationAuthMasked,
  maskDestinationAuth,
  parseDestinationAuth,
} from './destination-auth';
import {
  INGEST_PATH_PREFIX,
  REVOKE_NOTE,
  ROTATE_NOTE,
  SUBSCRIBER_NOT_FOUND_MESSAGE,
} from './subscribers.constants';

export interface Destination {
  method: DestinationMethod;
  url: string;
  headers: Record<string, string>;
  auth: DestinationAuthMasked;
}

/** 02 §4 wire shape — badge counts ride every list/detail payload (§10). */
export interface SubscriberSummary {
  id: number;
  workspaceId: number;
  name: string;
  status: 'active' | 'revoked';
  endpointUrl: string;
  ingestToken: string;
  destination: Destination;
  signatureHeader: string;
  receivedCount: number;
  verifiedCount: number;
  rejectedCount: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface SubscriberDetail extends SubscriberSummary {
  secretHint: string;
}

export interface RotateResult {
  secret: string;
  secretHint: string;
  rotatedAt: string;
  note: string;
}

export interface RevokeResult {
  revokedAt: string;
  note: string;
}

interface SubscriberCounts {
  receivedCount: number;
  verifiedCount: number;
  rejectedCount: number;
}

const ZERO_COUNTS: SubscriberCounts = {
  receivedCount: 0,
  verifiedCount: 0,
  rejectedCount: 0,
};

@Injectable()
export class SubscribersService {
  private readonly logger = new Logger(SubscribersService.name);

  /**
   * One validated source of truth for the public base URL: the same Joi gate
   * main.ts runs at boot, re-validated here at construction so a malformed
   * PUBLIC_BASE_URL fails module wiring instead of silently baking broken
   * endpoint URLs into list/detail payloads.
   */
  private readonly publicBaseUrl = validateEnv(process.env).PUBLIC_BASE_URL.replace(/\/+$/, '');

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
    private readonly secrets: SecretService,
  ) {}

  async list(workspaceId: number, userId: number): Promise<SubscriberSummary[]> {
    await this.membership.assertMember(workspaceId, userId);
    const rows = await this.prisma.subscriber.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    const counts = await this.loadCounts(rows.map((row) => row.id));
    return rows.map((row) => toSummary(row, counts.get(row.id) ?? ZERO_COUNTS, this.publicBaseUrl));
  }

  /**
   * The full secret exists only in this response and in RotateResult (02 §4):
   * the server keeps it plaintext to compute HMACs, so every other route
   * serializes secretHint instead.
   */
  async create(
    workspaceId: number,
    userId: number,
    dto: CreateSubscriberDto,
  ): Promise<SubscriberDetail & { secret: string }> {
    await this.membership.assertMember(workspaceId, userId);
    const ingestToken = this.secrets.generate();
    const secret = this.secrets.generate();
    // An absent field and an explicit `{ type: 'none' }` both mean "no
    // credential" on create; DbNull is SQL NULL, never the JSON value null.
    const destinationAuth =
      dto.destinationAuth === undefined ? Prisma.DbNull : parseDestinationAuth(dto.destinationAuth);
    const row = await this.prisma.subscriber.create({
      data: {
        workspaceId,
        name: dto.name,
        ingestToken,
        hmacSecret: secret,
        destinationMethod: dto.destinationMethod ?? DestinationMethod.POST,
        destinationUrl: dto.destinationUrl,
        destinationHeaders: dto.destinationHeaders ?? {},
        destinationAuth: destinationAuth ?? Prisma.DbNull,
        signatureHeaderName: dto.signatureHeader ?? DEFAULT_SIGNATURE_HEADER,
      },
    });
    return {
      ...toDetail(row, ZERO_COUNTS, this.secrets.hint(row.hmacSecret), this.publicBaseUrl),
      secret,
    };
  }

  async getDetail(subscriberId: number, userId: number): Promise<SubscriberDetail> {
    const row = await this.requireSubscriber(subscriberId);
    await this.membership.assertMember(row.workspaceId, userId);
    const counts = await this.loadCounts([row.id]);
    return toDetail(
      row,
      counts.get(row.id) ?? ZERO_COUNTS,
      this.secrets.hint(row.hmacSecret),
      this.publicBaseUrl,
    );
  }

  async update(
    subscriberId: number,
    userId: number,
    dto: UpdateSubscriberDto,
  ): Promise<SubscriberDetail> {
    const row = await this.requireSubscriber(subscriberId);
    await this.membership.assertMember(row.workspaceId, userId);

    // @IsOptional passes both `undefined` (key absent) and `null` (key
    // present with JSON null). Both mean "no change": the client only ever
    // holds a masked hint, so it can never resend a stored credential, and
    // the only sanctioned way to clear is the explicit `{ type: 'none' }`
    // marker below — a JSON null must never wipe a credential silently.
    const destinationAuth =
      dto.destinationAuth == null
        ? undefined
        : (parseDestinationAuth(dto.destinationAuth) ?? Prisma.DbNull); // 'none' = clear
    const data: Prisma.SubscriberUpdateInput = {
      name: dto.name ?? undefined,
      destinationUrl: dto.destinationUrl ?? undefined,
      destinationMethod: dto.destinationMethod ?? undefined,
      destinationHeaders: dto.destinationHeaders ?? undefined,
      destinationAuth,
      signatureHeaderName: dto.signatureHeader ?? undefined,
    };
    const hasChanges = Object.values(data).some((value) => value !== undefined);
    const updated = hasChanges
      ? await this.prisma.subscriber.update({ where: { id: subscriberId }, data })
      : row;

    const counts = await this.loadCounts([updated.id]);
    return toDetail(
      updated,
      counts.get(updated.id) ?? ZERO_COUNTS,
      this.secrets.hint(updated.hmacSecret),
      this.publicBaseUrl,
    );
  }

  async rotate(subscriberId: number, userId: number): Promise<RotateResult> {
    const row = await this.requireSubscriber(subscriberId);
    await this.membership.assertOwner(row.workspaceId, userId);
    const rotated = await this.secrets.rotate(subscriberId);
    // Audit trail for a credential-rotating action (conventions §6): subject
    // and timestamp only — the secret itself must never reach the log stream.
    this.logger.log(
      `event=subscriber.rotate subscriberId=${subscriberId} rotatedAt=${rotated.rotatedAt.toISOString()}`,
    );
    return {
      secret: rotated.secret,
      secretHint: rotated.secretHint,
      rotatedAt: rotated.rotatedAt.toISOString(),
      note: ROTATE_NOTE,
    };
  }

  /**
   * Idempotent: a second revoke keeps the original revokedAt instead of
   * rewriting the timestamp the UI shows as "revoked at".
   */
  async revoke(subscriberId: number, userId: number): Promise<RevokeResult> {
    const row = await this.requireSubscriber(subscriberId);
    await this.membership.assertOwner(row.workspaceId, userId);
    const revokedAt = row.revokedAt ?? new Date();
    if (row.revokedAt === null) {
      await this.prisma.subscriber.update({
        where: { id: subscriberId },
        data: { revokedAt },
      });
      // Audit trail for a credential-killing action (conventions §6); logged
      // once — the idempotent repeat writes nothing and changes nothing.
      this.logger.log(
        `event=subscriber.revoke subscriberId=${subscriberId} revokedAt=${revokedAt.toISOString()}`,
      );
    }
    return { revokedAt: revokedAt.toISOString(), note: REVOKE_NOTE };
  }

  async remove(subscriberId: number, userId: number): Promise<void> {
    const row = await this.requireSubscriber(subscriberId);
    await this.membership.assertOwner(row.workspaceId, userId);
    // A concurrent delete surfaces as P2025 → the global filter's 404.
    await this.prisma.subscriber.delete({ where: { id: subscriberId } });
  }

  private async requireSubscriber(subscriberId: number): Promise<Subscriber> {
    const row = await this.prisma.subscriber.findUnique({ where: { id: subscriberId } });
    if (row === null) {
      throw new NotFoundException({ message: SUBSCRIBER_NOT_FOUND_MESSAGE });
    }
    return row;
  }

  /**
   * One grouped query for any number of subscribers (anti N+1, conventions
   * §3). C2 removed pending state, so status is total over originals:
   * received = verified + rejected — no third count pass needed.
   */
  private async loadCounts(subscriberIds: number[]): Promise<Map<number, SubscriberCounts>> {
    const counts = new Map<number, SubscriberCounts>();
    if (subscriberIds.length === 0) {
      return counts;
    }
    const rows = await this.prisma.webhookRecord.groupBy({
      by: ['subscriberId', 'status'],
      where: receivedWhere({ subscriberId: { in: subscriberIds } }),
      _count: { _all: true },
    });
    for (const row of rows) {
      const bucket = counts.get(row.subscriberId) ?? { ...ZERO_COUNTS };
      if (row.status === RecordStatus.VERIFIED) {
        bucket.verifiedCount = row._count._all;
      } else {
        bucket.rejectedCount = row._count._all;
      }
      bucket.receivedCount = bucket.verifiedCount + bucket.rejectedCount;
      counts.set(row.subscriberId, bucket);
    }
    return counts;
  }
}

function endpointUrlFor(baseUrl: string, ingestToken: string): string {
  // The base comes pre-validated and slash-stripped from the service field
  // above, so a config oddity can never silently produce `…//ingest/…`.
  return `${baseUrl}${INGEST_PATH_PREFIX}${ingestToken}`;
}

function toHeaderRecord(stored: Subscriber['destinationHeaders']): Record<string, string> {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function toSummary(row: Subscriber, counts: SubscriberCounts, baseUrl: string): SubscriberSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.revokedAt === null ? 'active' : 'revoked',
    endpointUrl: endpointUrlFor(baseUrl, row.ingestToken),
    ingestToken: row.ingestToken,
    destination: {
      method: row.destinationMethod,
      url: row.destinationUrl,
      headers: toHeaderRecord(row.destinationHeaders),
      // Masked at the serialization boundary — the stored credential never
      // leaves this process (02 §4, same rule as secretHint).
      auth: maskDestinationAuth(row.destinationAuth),
    },
    signatureHeader: row.signatureHeaderName,
    receivedCount: counts.receivedCount,
    verifiedCount: counts.verifiedCount,
    rejectedCount: counts.rejectedCount,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  };
}

function toDetail(
  row: Subscriber,
  counts: SubscriberCounts,
  secretHint: string,
  baseUrl: string,
): SubscriberDetail {
  return { ...toSummary(row, counts, baseUrl), secretHint };
}
