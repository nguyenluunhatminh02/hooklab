import type { Request } from 'express';
import { PassThrough } from 'node:stream';
import { MAX_BODY_BYTES } from '../../common/constants/ingest.constants';
import { ingestRawBodyMiddleware } from './ingest-raw-body.middleware';

interface CapturedRequest extends PassThrough {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  bodyOverflow?: boolean;
}

function makeRequest(method = 'POST', headers: Record<string, string> = {}): CapturedRequest {
  const stream = new PassThrough() as CapturedRequest;
  stream.method = method;
  stream.headers = { 'content-type': 'application/json', ...headers };
  return stream;
}

/**
 * Runs the middleware and resolves once next() has been called. next is wired
 * to resolve BEFORE the handler runs so a settle that fires synchronously
 * (overflow inside the first write) still produces a settled promise.
 */
function runMiddleware(
  req: CapturedRequest,
): { next: jest.Mock; settled: Promise<void> } {
  const next = jest.fn();
  let resolveSettled: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  next.mockImplementation(() => {
    resolveSettled();
  });
  const middleware = ingestRawBodyMiddleware();
  middleware(req as unknown as Request, {} as never, next);
  return { next, settled };
}

describe('ingestRawBodyMiddleware', () => {
  it('captures a body of exactly MAX_BODY_BYTES across chunks without overflow', async () => {
    const req = makeRequest();
    const { next, settled } = runMiddleware(req);
    const half = MAX_BODY_BYTES / 2;
    req.write(Buffer.alloc(half, 0x61));
    req.write(Buffer.alloc(half, 0x62));
    req.end();
    await settled;

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.bodyOverflow).toBe(false);
    expect(req.rawBody).toBeDefined();
    expect(req.rawBody).toHaveLength(MAX_BODY_BYTES);
    expect(req.rawBody?.subarray(0, half)).toEqual(Buffer.alloc(half, 0x61));
    expect(req.rawBody?.subarray(half)).toEqual(Buffer.alloc(half, 0x62));
  });

  it('keeps content-length on a clean (non-overflow) request', async () => {
    const body = Buffer.from('{"ok":true}');
    const req = makeRequest('POST', { 'content-length': String(body.length) });
    const { next, settled } = runMiddleware(req);
    req.end(body);
    await settled;

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.bodyOverflow).toBe(false);
    expect(req.headers['content-length']).toBe(String(body.length));
    expect(req.rawBody).toEqual(body);
  });

  it('flags overflow and retains exactly cap+1 bytes when one extra byte arrives', async () => {
    const req = makeRequest('POST', {
      'content-length': String(MAX_BODY_BYTES + 4),
    });
    const { next, settled } = runMiddleware(req);
    req.write(Buffer.alloc(MAX_BODY_BYTES, 0x61));
    req.write(Buffer.alloc(4, 0x62));
    await settled;

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.bodyOverflow).toBe(true);
    expect(req.rawBody).toHaveLength(MAX_BODY_BYTES + 1);
    // The sentinel is the first byte of the chunk that crossed the cap.
    expect(req.rawBody?.subarray(0, MAX_BODY_BYTES)).toEqual(Buffer.alloc(MAX_BODY_BYTES, 0x61));
    expect(req.rawBody?.at(MAX_BODY_BYTES)).toBe(0x62);
  });

  it('strips framing headers on overflow so body-parser cannot short-circuit', async () => {
    const req = makeRequest('POST', {
      'content-length': String(MAX_BODY_BYTES + 1),
      'transfer-encoding': 'chunked',
    });
    const { settled } = runMiddleware(req);
    req.end(Buffer.alloc(MAX_BODY_BYTES + 1, 0x61));
    await settled;

    expect(req.bodyOverflow).toBe(true);
    expect(req.headers['content-length']).toBeUndefined();
    expect(req.headers['transfer-encoding']).toBeUndefined();
    // content-type must survive: the controller/service still classify the request.
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('stops reading after overflow — a later 10 MB write does not grow the buffer', async () => {
    const req = makeRequest();
    const { settled } = runMiddleware(req);
    req.write(Buffer.alloc(MAX_BODY_BYTES, 0x61));
    req.write(Buffer.alloc(10 * 1024 * 1024, 0x63));
    await settled;

    expect(req.bodyOverflow).toBe(true);
    expect(req.rawBody).toHaveLength(MAX_BODY_BYTES + 1);
  });

  it('round-trips non-UTF8 binary bytes intact (HMAC is over raw bytes)', async () => {
    const body = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x7f, 0xc0, 0x81]);
    const req = makeRequest();
    const { settled } = runMiddleware(req);
    req.end(body);
    await settled;

    expect(req.rawBody).toEqual(body);
    expect(req.bodyOverflow).toBe(false);
  });

  it('passes GET/HEAD through without buffering', async () => {
    for (const method of ['GET', 'HEAD']) {
      const req = makeRequest(method);
      const { next, settled } = runMiddleware(req);
      await settled;

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.rawBody).toBeUndefined();
      expect(req.bodyOverflow).toBeUndefined();
    }
  });

  it('settles exactly once even when end fires after an overflow settle', async () => {
    const req = makeRequest();
    const { next, settled } = runMiddleware(req);
    req.write(Buffer.alloc(MAX_BODY_BYTES + 1, 0x61));
    await settled;
    req.end();
    // Give the (already-removed) end listeners a turn; next must not fire again.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next once when the stream errors mid-upload', async () => {
    const req = makeRequest();
    const { next, settled } = runMiddleware(req);
    req.emit('error', new Error('socket reset'));
    await settled;

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.bodyOverflow).toBe(false);
    expect(req.rawBody).toHaveLength(0);
  });
});
