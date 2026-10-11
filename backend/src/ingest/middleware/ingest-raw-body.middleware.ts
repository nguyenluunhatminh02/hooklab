import type { RequestHandler } from 'express';
import { MAX_BODY_BYTES } from '../../common/constants/ingest.constants';

/**
 * Path-scoped raw-body capture for /ingest (§4.1, C16).
 *
 * Buffers chunks while total ≤ MAX_BODY_BYTES. At MAX_BODY_BYTES + 1 it keeps
 * exactly one sentinel byte past the cap and STOPS READING — a hostile 10 GB
 * upload must not be drained before the 413 goes out (memory and time stay
 * bounded). Sets `req.rawBody` and `req.bodyOverflow`, never throws, always
 * calls next() unless the client aborted.
 *
 * Registered in main.ts BEFORE express.json — a MiddlewareConsumer
 * registration would run after Nest's parser (the ordering bug this avoids).
 */
export function ingestRawBodyMiddleware(): RequestHandler {
  const cap = MAX_BODY_BYTES;
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      req.rawBody = Buffer.concat(chunks);
      req.bodyOverflow = total > cap;
      if (req.bodyOverflow) {
        // body-parser (express 5) skips only requests it considers finished or
        // body-less (onFinished.isFinished → type-is.hasBody). We stopped
        // reading mid-stream, so without this the global express.json() would
        // resume the socket, trip its own 100kb limit, and answer a bare 413
        // before the ingest route — no record, wrong envelope (verified
        // against body-parser 2.3.0 read.js). Stripping the framing headers
        // routes past hasBody honestly; faking req.complete instead would
        // corrupt Node's keep-alive accounting for the unread remainder.
        delete req.headers['content-length'];
        delete req.headers['transfer-encoding'];
      }
      next();
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total <= cap) {
        chunks.push(chunk);
        return;
      }
      // Overflow: retain only the byte that crosses the cap (cap+1 total),
      // then pause the stream and settle — the 413 must not wait for 'end'.
      const overshoot = total - cap;
      chunks.push(chunk.subarray(0, Math.min(overshoot, 1)));
      req.pause();
      settle();
    };

    const onEnd = (): void => settle();
    const onError = (): void => settle();
    const onAborted = (): void => {
      // Client hung up mid-upload: no handler runs, nothing to respond to.
      settled = true;
      cleanup();
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  };
}
