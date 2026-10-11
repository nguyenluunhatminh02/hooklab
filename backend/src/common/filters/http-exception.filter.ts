import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '../../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_PATTERN } from '../constants/app.constants';
import { MAX_BODY_BYTES } from '../constants/ingest.constants';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

interface RequestWithId {
  id?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Express body-parser error shape (`PayloadTooLargeError`, `SyntaxError`) — plain Error instances carrying runtime markers. */
interface BodyParserError {
  name?: string;
  type?: string;
  status?: number;
  statusCode?: number;
  limit?: number;
  message?: string;
}

function statusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'validation_error';
    case HttpStatus.UNAUTHORIZED:
      return 'unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'forbidden';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.CONFLICT:
      return 'conflict';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'body_too_large';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}

/**
 * THE one global catch-all filter (BUILD_PLAN §3.1, conventions §3).
 * Maps Prisma P2002→409 / P2025→404, passes HttpException through, everything
 * else → 500. Every response uses the 02 §1.2 envelope and carries requestId.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestWithId>();
    const requestId = this.resolveRequestId(request);

    let status: number;
    let code: string;
    let message: string;
    let details: unknown;

    // Detect body-parser errors (express.json/raw) which are Error instances,
    // not HttpException. The instanceof guard matters: Nest's HttpException
    // also carries a runtime `.status`, so an envelope-shaped 413 thrown by a
    // controller (ingest) would otherwise be swallowed by this branch and its
    // precise message replaced by the fallback.
    const maybeErr = exception as BodyParserError;
    const isHttpException = exception instanceof HttpException;
    const isPayloadTooLarge =
      !isHttpException &&
      (maybeErr?.name === 'PayloadTooLargeError' ||
        maybeErr?.type === 'entity.too.large' ||
        maybeErr?.statusCode === 413 ||
        maybeErr?.status === 413);
    const isEntityParseFailed =
      !isHttpException &&
      (maybeErr?.name === 'SyntaxError' ||
        maybeErr?.type === 'entity.parse.failed' ||
        maybeErr?.type === 'request.entity.parse.failed');

    if (isPayloadTooLarge) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = 'body_too_large';
      const limit = maybeErr?.limit ?? MAX_BODY_BYTES;
      const bytes = typeof limit === 'number' ? limit : Number(limit) || MAX_BODY_BYTES;
      message = `request body exceeds ${bytes} bytes`;
      details = undefined;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      const isEnvelopeShaped =
        typeof response === 'object' &&
        response !== null &&
        'error' in response &&
        typeof (response as ErrorEnvelope).error === 'object' &&
        (response as ErrorEnvelope).error !== null;
      if (isEnvelopeShaped) {
        // Already a 02 §1.2 envelope ({error:{code,...}}) — pass it through.
        const envelope = (response as unknown as ErrorEnvelope).error;
        code = envelope.code;
        message = envelope.message;
        details = envelope.details;
      } else if (typeof response === 'object' && response !== null && 'message' in response) {
        // Nest's built-in bodies (e.g. ValidationPipe's {statusCode, message,
        // error: 'Bad Request'}) have no `code` — derive it from the status so
        // 400 answers validation_error per 02 §1.4 instead of shipping no code.
        const body = response as { message?: string | string[] };
        message = Array.isArray(body.message)
          ? body.message.join('; ')
          : String(body.message);
        code = statusToCode(status);
        details = Array.isArray(body.message) ? body.message : undefined;
      } else {
        message = exception.message;
        code = statusToCode(status);
      }
    } else if (isEntityParseFailed) {
      status = HttpStatus.BAD_REQUEST;
      code = 'validation_error';
      message = maybeErr?.message || 'invalid JSON';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        const uniqueField = uniqueConstraintField(exception);
        code = uniqueField === 'email' ? 'email_taken' : 'conflict';
        message =
          uniqueField === 'email'
            ? 'an account with this email already exists'
            : 'resource already exists';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'not_found';
        message = 'resource not found';
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        code = 'internal_error';
        message = 'internal server error';
        this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = 'internal_error';
      message = 'internal server error';
      this.logger.error(
        `Unhandled exception: ${exception instanceof Error ? exception.stack : String(exception)}`,
      );
    }

    const envelope: ErrorEnvelope = {
      error: { code, message, requestId, ...(details !== undefined ? { details } : {}) },
    };
    httpAdapter.reply(ctx.getResponse(), envelope, status);
  }

  private resolveRequestId(request: RequestWithId): string {
    if (typeof request.id === 'string' && REQUEST_ID_PATTERN.test(request.id)) {
      return request.id;
    }
    const headerId = request.headers['x-request-id'];
    const fromHeader = Array.isArray(headerId) ? headerId[0] : headerId;
    // L-4: only a well-formed client id survives into the error envelope;
    // anything else (missing, oversized, weird charset) gets a fresh id.
    if (typeof fromHeader === 'string' && REQUEST_ID_PATTERN.test(fromHeader)) {
      return fromHeader;
    }
    return `req_${randomUUID()}`;
  }
}

/**
 * Which unique constraint did P2002 trip? Two possible shapes, depending on
 * how Prisma reached Postgres:
 *  - legacy engine: `meta.target` = ['email']
 *  - driver adapter (Prisma 7 + pg): `meta.target` is absent; the constraint
 *    name lives at `meta.driverAdapterError.cause.constraint.index`
 *    (e.g. 'User_email_key' — captured live from the real client).
 * Returns null when the column cannot be identified — 'conflict' is the
 * honest answer then; guessing a field would mislabel the error.
 */
function uniqueConstraintField(
  exception: Prisma.PrismaClientKnownRequestError,
): string | null {
  const meta: unknown = exception.meta;
  const target = (meta as { target?: unknown } | null)?.target;
  if (Array.isArray(target)) {
    return target.includes('email') ? 'email' : null;
  }
  const index = (
    meta as { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } } | null
  )?.driverAdapterError?.cause?.constraint?.index;
  if (typeof index === 'string' && index.includes('email')) return 'email';
  return null;
}
