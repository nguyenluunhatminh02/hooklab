import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AbstractHttpAdapter, HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '../../generated/prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost(
  request: { id?: string; headers: Record<string, string | string[] | undefined> } = { headers: {} },
): [HttpAdapterHost, { reply: jest.Mock; ctx: ArgumentsHost }] {
  const reply = jest.fn();
  const adapter = { reply } as unknown as AbstractHttpAdapter;
  const httpAdapterHost = { httpAdapter: adapter } as unknown as HttpAdapterHost;
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as ArgumentsHost;
  return [httpAdapterHost, { reply, ctx }];
}

function makeP2002Legacy(email: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${email})`,
    {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: [email] },
    },
  );
}

function makeP2002Driver(email: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`email`)',
    {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: {
        modelName: 'User',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: `duplicate key value violates unique constraint "${email}_key"`,
            kind: 'UniqueConstraintViolation',
            constraint: { index: `${email}_key` },
            table: 'User',
          },
        },
      },
    },
  );
}

function makeP2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
    code: 'P2025',
    clientVersion: '7.10.0',
  });
}

describe('HttpExceptionFilter', () => {
  it('P2002 with legacy meta.target -> email_taken', () => {
    const [httpAdapterHost, { reply, ctx }] = createHost();
    const filter = new HttpExceptionFilter(httpAdapterHost);
    const err = makeP2002Legacy('email');
    filter.catch(err, ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, envelope, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(envelope.error.code).toBe('email_taken');
  });

  it('P2002 with driver adapter shape (no target) -> email_taken', () => {
    const [httpAdapterHost, { reply, ctx }] = createHost();
    const filter = new HttpExceptionFilter(httpAdapterHost);
    const err = makeP2002Driver('email');
    filter.catch(err, ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, envelope, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(envelope.error.code).toBe('email_taken');
  });

  it('P2025 -> 404 not_found (deleted-mid-flight race, 03 §4.5)', () => {
    const [httpAdapterHost, { reply, ctx }] = createHost();
    const filter = new HttpExceptionFilter(httpAdapterHost);
    filter.catch(makeP2025(), ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, envelope, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(envelope.error.code).toBe('not_found');
    expect(envelope.error.message).toBe('resource not found');
  });

  it('PayloadTooLargeError uses limit from error if present', () => {
    const [httpAdapterHost, { reply, ctx }] = createHost();
    const filter = new HttpExceptionFilter(httpAdapterHost);
    const err = { name: 'PayloadTooLargeError', type: 'entity.too.large', status: 413, limit: 102400 };
    filter.catch(err, ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, envelope, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(envelope.error.code).toBe('body_too_large');
    expect(envelope.error.message).toBe('request body exceeds 102400 bytes');
  });

  it('PayloadTooLargeError falls back to MAX_BODY_BYTES when limit missing', () => {
    const [httpAdapterHost, { reply, ctx }] = createHost();
    const filter = new HttpExceptionFilter(httpAdapterHost);
    const err = { name: 'PayloadTooLargeError', type: 'entity.too.large', status: 413 };
    filter.catch(err, ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, envelope, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(envelope.error.code).toBe('body_too_large');
    expect(envelope.error.message).toBe('request body exceeds 1048576 bytes');
  });

  it('envelope-shaped HttpException passes through', () => {
    const [httpAdapterHost, { reply, ctx }] = createHost();
    const filter = new HttpExceptionFilter(httpAdapterHost);
    const err = new HttpException(
      { error: { code: 'body_too_large', message: 'request body exceeds 1100000 bytes' } },
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
    filter.catch(err, ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    const [, envelope, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(envelope.error.code).toBe('body_too_large');
    expect(envelope.error.message).toBe('request body exceeds 1100000 bytes');
  });

  // L-4 (filter layer; app.module's genReqId is layer 1 and has its own e2e):
  // the requestId echoed into the envelope must come from a well-formed source
  // or be freshly generated — a crafted id must never survive verbatim.
  describe('requestId resolution (L-4)', () => {
    const captureRequestId = (request: {
      id?: string;
      headers: Record<string, string | string[] | undefined>;
    }): string => {
      const [httpAdapterHost, { reply, ctx }] = createHost(request);
      new HttpExceptionFilter(httpAdapterHost).catch(new Error('boom'), ctx);
      const [, envelope] = reply.mock.calls[0];
      return envelope.error.requestId as string;
    };

    it('reuses a well-formed request.id verbatim', () => {
      expect(captureRequestId({ id: 'abc-123_X.Y', headers: {} })).toBe('abc-123_X.Y');
    });

    it('ignores an oversized request.id and generates a fresh one', () => {
      const requestId = captureRequestId({ id: 'a'.repeat(129), headers: {} });
      expect(requestId).not.toBe('a'.repeat(129));
      expect(requestId).toMatch(/^req_/);
    });

    it('falls back to a well-formed x-request-id header', () => {
      expect(captureRequestId({ headers: { 'x-request-id': 'client-correlation-1' } })).toBe(
        'client-correlation-1',
      );
    });

    it('rejects a malformed x-request-id header (charset) and generates a fresh one', () => {
      const requestId = captureRequestId({ headers: { 'x-request-id': 'bad id <script>' } });
      expect(requestId).not.toBe('bad id <script>');
      expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    });

    it('generates a fresh id when neither source is present', () => {
      expect(captureRequestId({ headers: {} })).toMatch(/^req_[0-9a-f-]{36}$/);
    });
  });
});
