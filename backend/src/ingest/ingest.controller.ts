import { Controller, HttpCode, HttpException, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Request } from 'express';
import { MAX_BODY_BYTES } from '../common/constants/ingest.constants';
import { Public } from '../common/guards/public.decorator';
import { IngestOutcome, IngestService } from './ingest.service';

type IngestFailure = Exclude<IngestOutcome, { status: HttpStatus.OK }>;

const INGEST_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'no ingest endpoint for this token',
  subscriber_revoked: 'subscriber token has been revoked',
  body_too_large: `request body exceeds ${MAX_BODY_BYTES} bytes`,
  rate_limited: 'rate limit exceeded for this endpoint',
  unauthorized: 'signature verification failed',
};

/**
 * Builds an HttpException carrying the 02 §1.2 envelope itself
 * (`{error: {code, message, details}}`) — the global HttpExceptionFilter's
 * envelope branch passes that through untouched, so ingest failures keep
 * their machine-readable code instead of falling back to a status mapping.
 */
function toHttpException(outcome: IngestFailure): HttpException {
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: {
      code: outcome.code,
      message: INGEST_ERROR_MESSAGES[outcome.code],
    },
  };
  if (outcome.status === HttpStatus.UNAUTHORIZED) {
    body.error.details = { reason: outcome.reason };
  }
  return new HttpException(body, outcome.status);
}

@Public()
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post(':token')
  // Nest defaults POST to 201; §3.3 contract says a verified capture is 200.
  @HttpCode(HttpStatus.OK)
  async capture(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const outcome = await this.ingestService.handle({
      token,
      rawBody: req.rawBody ?? Buffer.alloc(0),
      bodyOverflow: req.bodyOverflow === true,
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
    });

    if (outcome.status === HttpStatus.OK) {
      return { data: { recordId: outcome.recordId, status: 'verified' } };
    }
    if (outcome.status === HttpStatus.TOO_MANY_REQUESTS) {
      // Set before throwing: the filter's reply keeps headers already on res.
      res.set('Retry-After', String(outcome.retryAfterSeconds));
    }
    throw toHttpException(outcome);
  }
}
