import { BadRequestException, GoneException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DestinationMethod, Prisma, RecordStatus, RejectReason, ReplayError } from '../generated/prisma/client';
import { RESPONSE_BODY_MAX_BYTES } from '../common/constants/app.constants';
import { REPLAY_TIMEOUT_MS } from '../common/constants/ingest.constants';
import { MembershipService } from '../common/membership/membership.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ReplayDto } from './dto/replay.dto';
import { resolveDestination } from './ssrf';
import {
  destinationAuthCredentials,
  isReplaySafeAuthHeader,
  redactDestinationResponseBody,
  type DestinationAuthHeader,
} from '../subscribers/destination-auth';

function asRequiredJson(value: Prisma.JsonValue): Prisma.InputJsonValue {
  // headers IS NOT NULL in the schema: null only appears on a legacy row, in
  // which case JsonNull reproduces the original capture exactly.
  if (value === null) return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  return value as Prisma.InputJsonValue;
}

export interface ReplaySuccess {
  data: {
    replayRecordId: number;
    outcome: 'ok';
    response: { status: number; body: string | null; durationMs: number };
    savedAt: string;
  };
}

interface ReplaySourceRecord {
  id: number;
  subscriberId: number;
  method: string;
  url: string;
  headers: Prisma.JsonValue;
  rawBody: string;
  bodyBytes: number;
  status: RecordStatus;
  rejectReason: RejectReason | null;
  eventType: string | null;
  subscriber: {
    workspaceId: number;
    revokedAt: Date | null;
    destinationMethod: DestinationMethod;
    destinationUrl: string;
    destinationHeaders: Prisma.JsonValue;
    destinationAuth: Prisma.JsonValue;
  };
}

interface ReplayLeg {
  responseStatus: number | null;
  responseBody: string | null;
  replayError: ReplayError | null;
  durationMs: number;
  replayedAt: Date;
}

const BLOCKED_MESSAGE = 'replay target blocked: private, link-local, or unresolvable address';
const SUBSCRIBER_REVOKED_MESSAGE = 'subscriber revoked — destination is no longer a live target';
const RECORD_EXPIRED_MESSAGE = 'record expired between read and insert';

@Injectable()
export class ReplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  async replay(recordId: number, userId: number, dto: ReplayDto): Promise<ReplaySuccess> {
    const record = await this.prisma.webhookRecord.findUnique({
      where: { id: recordId },
      include: {
        subscriber: {
          select: {
            workspaceId: true,
            revokedAt: true,
            destinationMethod: true,
            destinationUrl: true,
            destinationHeaders: true,
            destinationAuth: true,
          },
        },
      },
    });
    if (record === null) throw new NotFoundException({ message: 'record not found' });
    await this.membership.assertMember(record.subscriber.workspaceId, userId);
    if (record.subscriber.revokedAt !== null) {
      // 02 §6/C18: a revoked subscriber has no live target — 410, and no replay row.
      throw new GoneException({ error: { code: 'subscriber_revoked', message: SUBSCRIBER_REVOKED_MESSAGE } });
    }

    const destination = this.destinationUrl(record.subscriber.destinationUrl);
    // C3: a blocked target answers 400 before any insert and before fetch runs.
    const verdict = await resolveDestination(destination);
    if (verdict.blocked) {
      throw new BadRequestException({
        error: { code: 'replay_target_blocked', message: BLOCKED_MESSAGE, details: { blockedIp: verdict.blockedIp } },
      });
    }

    const body = JSON.stringify(dto.body);
    const startedAt = Date.now();
    const savedAt = new Date();

    // Transport scope only: everything that can fail because of the destination
    // (fetch establishment, response body read) stays in here. A failure in the
    // DB persistence below is a different failure class and must NOT be re-routed
    // through this catch — that would mislabel a green destination as an upstream
    // error (02 §6) or rewrite a P2025 as a 502.
    let transport: { responseStatus: number | null; responseBody: string | null; timedOut: boolean };
    try {
      // The exact header this leg will send — the same object the wire sees, so
      // redaction can never target a value that was not actually emitted.
      const authHeader = destinationAuthHeader(record.subscriber.destinationAuth);
      const response = await fetch(destination, {
        method: record.subscriber.destinationMethod,
        // BUILD_PLAN §4.5: our JSON content-type first, destination headers may
        // override it, and 02 §4: a configured credential outranks any
        // destinationHeaders entry naming the same header — a credential is
        // explicit config, the header map is a passthrough (a conflicting entry
        // is ambiguous config, not a signal to omit auth). The merge must fold
        // names case-insensitively (HTTP field names are): plain object spread
        // would leave both spellings as keys and undici comma-joins them.
        headers: mergeHeaders(
          { 'content-type': 'application/json' },
          destinationHeaders(record.subscriber.destinationHeaders),
          authHeader === null ? {} : { [authHeader.headerName]: authHeader.headerValue },
        ),
        body,
        signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
        // 302-following is off: a redirect could land on an address the SSRF
        // check above never saw (03 §4.3).
        redirect: 'manual',
      });
      // An echo destination (httpbin) reflects the request — including the
      // outbound credential — into its reply, and that reply is stored as the
      // leg's response body (02 §5). Redact the exact value this request sent
      // BEFORE the byte cap: truncating first could cut a credential that
      // straddles the cap into a partial string that exact-match no longer
      // catches (02 §4 "never serialized").
      const responseBody = truncateBody(
        redactDestinationResponseBody(await response.text(), authHeader),
      );
      // text() resolved, so the destination answered and we have its body —
      // even if the deadline landed just after the read completed.
      transport = { responseStatus: response.status, responseBody, timedOut: false };
    } catch (error) {
      // fetch itself failed, or the body read was cut short (timeout or read
      // error) — both are transport legs, never a success row.
      transport = { responseStatus: null, responseBody: null, timedOut: isAbortTimeout(error) };
    }
    const durationMs = Date.now() - startedAt;

    // Persistence scope: insertReplay's own P2025 -> NotFoundException (retention
    // deleted the original mid-flight) must surface as 404 and never re-enter the
    // transport catch.
    const leg: ReplayLeg = {
      responseStatus: transport.responseStatus,
      responseBody: transport.responseBody,
      replayError:
        transport.responseStatus !== null
          ? null
          : transport.timedOut
            ? ReplayError.REPLAY_TIMEOUT
            : ReplayError.REPLAY_UPSTREAM_ERROR,
      durationMs,
      replayedAt: savedAt,
    };
    const row = await this.insertReplay(record, leg);

    if (transport.timedOut) {
      throw new HttpException(
        {
          error: {
            code: 'replay_timeout',
            message: `destination did not respond within ${REPLAY_TIMEOUT_MS / 1000} s`,
            details: { replayRecordId: row.id },
          },
        },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (transport.responseStatus === null) {
      throw new HttpException(
        {
          error: {
            code: 'replay_upstream_error',
            message: 'destination unreachable — connection failed',
            details: { replayRecordId: row.id },
          },
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return {
      data: {
        replayRecordId: row.id,
        outcome: 'ok',
        response: { status: transport.responseStatus, body: transport.responseBody, durationMs },
        savedAt: savedAt.toISOString(),
      },
    };
  }

  private destinationUrl(raw: string): URL {
    let destination: URL;
    try {
      destination = new URL(raw);
    } catch {
      // destinationUrl is validated at subscriber create; a row that predates that
      // gate still must not reach fetch — same blocked outcome, no record (C3).
      throw blocked(null);
    }
    const isHttp = destination.protocol === 'http:' || destination.protocol === 'https:';
    if (!isHttp || destination.username !== '' || destination.password !== '') {
      throw blocked(null);
    }
    return destination;
  }

  private async insertReplay(record: ReplaySourceRecord, leg: ReplayLeg): Promise<{ id: number }> {
    try {
      return await this.prisma.webhookRecord.create({
        data: {
          // Replay rows copy the original's request fields (01 §4): the detail
          // view renders children without a join, and received-counts never see
          // them because receivedWhere() excludes replayOfId != null. receivedAt
          // is NOT copied — each leg takes its own insert time, which is also
          // its sort key in the detail timeline (02 §5).
          subscriberId: record.subscriberId,
          method: record.method,
          url: record.url,
          headers: asRequiredJson(record.headers),
          rawBody: record.rawBody,
          bodyBytes: record.bodyBytes,
          status: record.status,
          rejectReason: record.rejectReason,
          eventType: record.eventType,
          replayOfId: record.id,
          replayTargetUrl: record.subscriber.destinationUrl,
          responseStatus: leg.responseStatus,
          responseBody: leg.responseBody,
          replayError: leg.replayError,
          replayedAt: leg.replayedAt,
          durationMs: leg.durationMs,
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        // Retention deleted the original while the fetch was in flight — surface
        // 404 (record gone), not a 500.
        throw new NotFoundException({ message: RECORD_EXPIRED_MESSAGE });
      }
      throw error;
    }
  }
}

function blocked(blockedIp: string | null): BadRequestException {
  return new BadRequestException({
    error: { code: 'replay_target_blocked', message: BLOCKED_MESSAGE, details: { blockedIp } },
  });
}

function isAbortTimeout(error: unknown): boolean {
  // AbortSignal.timeout raises TimeoutError (AbortError on older paths). Only our
  // own signal can abort this fetch, so either name means the 10 s budget elapsed.
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Left-to-right header merge that folds keys case-insensitively: HTTP field
 * names are case-insensitive, but object spread only overwrites on an exact
 * spelling match, so `{ Authorization: stale, authorization: fresh }` would
 * reach fetch as two keys — and undici comma-joins duplicates on the wire
 * ("Bearer stale, Bearer fresh"), defeating the credential. Later sources win
 * and keep their own spelling, so callers bind defaults first and credentials
 * last.
 */
function mergeHeaders(...sources: Record<string, string>[]): Record<string, string> {
  const folded = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      folded.set(name.toLowerCase(), { name, value });
    }
  }
  return Object.fromEntries([...folded.values()].map(({ name, value }) => [name, value]));
}

function destinationHeaders(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  // DTO validates string values at write time; the filter keeps fetch's header map
  // typed for legacy rows without an unchecked cast.
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * The outbound credential header this leg will actually send, or null. Built by
 * the module that owns the destinationAuth contract (single source of truth) and
 * re-checked here as defense in depth: a legacy row could predate the DTO gate,
 * and this is the last code that runs before fetch sees the header. The same
 * object feeds both the wire headers and the response-body redaction, so the
 * two can never disagree on what was emitted.
 */
function destinationAuthHeader(value: Prisma.JsonValue): DestinationAuthHeader {
  const credentials = destinationAuthCredentials(value);
  if (credentials === null) return null;
  return isReplaySafeAuthHeader(credentials.headerName, credentials.headerValue) ? credentials : null;
}

function truncateBody(text: string): string {
  // Same 1 MB storage cap as the capture path (02 §6) — replay legs never grow a row.
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= RESPONSE_BODY_MAX_BYTES ? text : bytes.subarray(0, RESPONSE_BODY_MAX_BYTES).toString('utf8');
}
