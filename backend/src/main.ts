import 'dotenv/config';
import { validateEnv } from './config/env.validation';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { MAX_BODY_BYTES } from './common/constants/ingest.constants';
import { ingestRawBodyMiddleware } from './ingest/middleware/ingest-raw-body.middleware';

async function bootstrap(): Promise<void> {
  // Fail fast on bad env before anything touches the network (conventions §6).
  const env = validateEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // §4.1 — we own parser order
  });

  // 1) raw capture for /ingest BEFORE any JSON parser (§4.1)
  app.use('/ingest', ingestRawBodyMiddleware());
  // 2) replay carries a user-edited copy of a captured body (≤ MAX_BODY_BYTES),
  //    so it must parse at the capture cap — not the 100kb API default, or a
  //    legitimately captured record becomes unreplayable (the parser rejection
  //    is the documented 413 body_too_large failure — 02 §6).
  app.use('/api/records/:recordId/replay', express.json({ limit: MAX_BODY_BYTES }));
  // 3) everything else parses normally
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true }));

  app.useLogger(app.get(Logger));

  await app.listen(env.PORT);
  app.get(Logger).log(`HookLab API listening on :${env.PORT} (max body ${MAX_BODY_BYTES}B)`);
}

void bootstrap().catch((error: unknown) => {
  console.error('Fatal bootstrap error:', error);
  process.exit(1);
});
