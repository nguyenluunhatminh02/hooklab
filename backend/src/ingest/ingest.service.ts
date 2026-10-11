import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { verifySignature } from '../common/crypto/hmac';
import { MAX_BODY_BYTES } from '../common/constants/ingest.constants';
import { PrismaService } from '../common/prisma/prisma.service';
import { RejectReason, RecordStatus } from '../generated/prisma/enums';
import { RateLimitService } from './rate-limit.service';

export interface IngestRequestInput {
  token: string;
  rawBody: Buffer;
  bodyOverflow: boolean;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export type IngestSignatureReason = 'missing_signature' | 'invalid_signature';

export type IngestOutcome =
  | { status: HttpStatus.NOT_FOUND; code: 'not_found' }
  | { status: HttpStatus.GONE; code: 'subscriber_revoked' }
  | { status: HttpStatus.PAYLOAD_TOO_LARGE; code: 'body_too_large'; recordId: number }
  | {
      status: HttpStatus.TOO_MANY_REQUESTS;
      code: 'rate_limited';
      recordId: number;
      retryAfterSeconds: number;
    }
  | {
      status: HttpStatus.UNAUTHORIZED;
      code: 'unauthorized';
      recordId: number;
      reason: IngestSignatureReason;
    }
  | { status: HttpStatus.OK; recordId: number };

/** C15: subscriber signature header + these three, keys lowercased, nothing else. */
const STANDARD_WHITELISTED_HEADERS = ['x-request-id', 'user-agent', 'content-type'] as const;


interface RecordDraft {
  subscriberId: number;
  input: IngestRequestInput;
  headers: Record<string, string | string[]>;
  eventType: string | null;
  rawBody: string;
  bodyBytes: number;
  status: RecordStatus;
  rejectReason: RejectReason | null;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * State machine per BUILD_PLAN §4.2 — the gate order is the contract:
   * token resolve (404/410, no record) → body size (413, record, rate limiter
   * untouched) → sliding-window rate (429, record, not counted) → capture
   * (verify + single terminal insert) → respond. Record-then-respond always.
   */
  async handle(input: IngestRequestInput): Promise<IngestOutcome> {
    const subscriber = await this.prisma.subscriber.findUnique({
      where: { ingestToken: input.token },
      select: { id: true, revokedAt: true, signatureHeaderName: true },
    });
    if (!subscriber) {
      return { status: HttpStatus.NOT_FOUND, code: 'not_found' };
    }
    if (subscriber.revokedAt !== null) {
      return { status: HttpStatus.GONE, code: 'subscriber_revoked' };
    }

    // eventType is pulled before whitelisting drops the non-stored headers (C15).
    const eventType = this.extractEventType(input);
    const headers = this.pickWhitelistedHeaders(input.headers, subscriber.signatureHeaderName);

    if (input.bodyOverflow) {
      // C1: size check precedes the rate check — an oversized body is 413 even
      // when the window is full, and the rate limiter is never consulted.
      const recordId = await this.createRecord({
        subscriberId: subscriber.id,
        input,
        headers,
        eventType,
        rawBody: '',
        bodyBytes: MAX_BODY_BYTES + 1,
        status: RecordStatus.REJECTED,
        rejectReason: RejectReason.BODY_TOO_LARGE,
      });
      return { status: HttpStatus.PAYLOAD_TOO_LARGE, code: 'body_too_large', recordId };
    }

    const decision = await this.rateLimit.acquire(subscriber.id);
    if (!decision.admitted) {
      const recordId = await this.createRecord({
        subscriberId: subscriber.id,
        input,
        headers,
        eventType,
        rawBody: input.rawBody.toString('utf8'),
        bodyBytes: input.rawBody.length,
        status: RecordStatus.REJECTED,
        rejectReason: RejectReason.RATE_LIMITED,
      });
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'rate_limited',
        recordId,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }

    return this.capture(subscriber.id, input, eventType);
  }

  /**
   * Capture (§4.2 step 4): its own transaction that re-takes the advisory lock
   * and re-reads hmacSecret here — never the row from token resolve. Rotate
   * holds the same lock, so a rotate that committed before we got the lock is
   * already visible; a pre-rotate secret can never verify a post-rotate body.
   */
  private async capture(
    subscriberId: number,
    input: IngestRequestInput,
    eventType: string | null,
  ): Promise<IngestOutcome> {
    return this.prisma.$transaction<IngestOutcome>(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${subscriberId}::bigint)`;

      const current = await tx.subscriber.findUnique({
        where: { id: subscriberId },
        select: { hmacSecret: true, signatureHeaderName: true },
      });
      if (!current) {
        // Deleted between token resolve and capture; the FK forbids a record row.
        return { status: HttpStatus.NOT_FOUND, code: 'not_found' };
      }

      const headerValue = input.headers[current.signatureHeaderName.toLowerCase()];
      const verdict = verifySignature(input.rawBody, headerValue, current.hmacSecret);

      // C2: one insert with the terminal status — no pending row, and the
      // insert commits before the controller emits any response.
      const record = await tx.webhookRecord.create({
        data: {
          subscriberId,
          method: input.method,
          url: input.url,
          headers: this.pickWhitelistedHeaders(input.headers, current.signatureHeaderName),
          rawBody: input.rawBody.toString('utf8'),
          bodyBytes: input.rawBody.length,
          status: verdict.ok ? RecordStatus.VERIFIED : RecordStatus.REJECTED,
          rejectReason: verdict.ok
            ? null
            : verdict.reason === 'missing_signature'
              ? RejectReason.MISSING_SIGNATURE
              : RejectReason.INVALID_SIGNATURE,
          eventType,
        },
      });

      return verdict.ok
        ? { status: HttpStatus.OK, recordId: record.id }
        : {
            status: HttpStatus.UNAUTHORIZED,
            code: 'unauthorized',
            recordId: record.id,
            reason: verdict.reason,
          };
    });
  }

  private async createRecord(draft: RecordDraft): Promise<number> {
    const record = await this.prisma.webhookRecord.create({
      data: {
        subscriberId: draft.subscriberId,
        method: draft.input.method,
        url: draft.input.url,
        headers: draft.headers,
        rawBody: draft.rawBody,
        bodyBytes: draft.bodyBytes,
        status: draft.status,
        rejectReason: draft.rejectReason,
        eventType: draft.eventType,
      },
    });
    return record.id;
  }

  private pickWhitelistedHeaders(
    headers: Record<string, string | string[] | undefined>,
    signatureHeaderName: string,
  ): Record<string, string | string[]> {
    const allowed = new Set<string>([
      signatureHeaderName.toLowerCase(),
      ...STANDARD_WHITELISTED_HEADERS,
    ]);
    const picked: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (allowed.has(lowerKey) && value !== undefined) {
        picked[lowerKey] = value;
      }
    }
    return picked;
  }

  /** Best-effort per design 01: body.type → body.event → x-event-type header. */
  private extractEventType(input: IngestRequestInput): string | null {
    if (!input.bodyOverflow) {
      try {
        const parsed: unknown = JSON.parse(input.rawBody.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const body = parsed as Record<string, unknown>;
          if (typeof body.type === 'string') {
            return body.type;
          }
          if (typeof body.event === 'string') {
            return body.event;
          }
        }
      } catch (error) {
        // Non-JSON senders (form posts, plain text) are normal traffic, not a
        // failure — the contract says eventType falls back to the header/null.
        this.logger.debug(
          `ingest body is not JSON, eventType falls back to header: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const header = input.headers['x-event-type'];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
