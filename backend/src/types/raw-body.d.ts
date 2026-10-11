import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Exact received bytes for /ingest (set by ingestRawBodyMiddleware). */
      rawBody?: Buffer;
      /** True when the payload exceeded MAX_BODY_BYTES (sentinel bodyBytes). */
      bodyOverflow?: boolean;
    }
  }
}

export {};
