import 'dotenv/config'; // CI sets DATABASE_URL workflow-wide; local runs need backend/.env
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ingestRawBodyMiddleware } from '../src/ingest/middleware/ingest-raw-body.middleware';
import { MAX_BODY_BYTES, RATE_LIMIT_MAX } from '../src/common/constants/ingest.constants';

// Outbound replay leg is stubbed at both ends the way replay.service.spec
// stubs them: DNS answers one public IP (SSRF still evaluates it) and fetch
// answers 200. The e2e owns the HTTP surface, not the internet — a live
// destination would make this spec flaky on any offline/CI runner.
jest.mock('dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));
jest.mock('node:dns', () => ({ isIPv4: jest.requireActual('node:dns').isIPv4 }));

describe('E2E happy path (§8.2 last row)', () => {
  let app: INestApplication;
  const originalFetch = global.fetch;
  const runId = `${Date.now()}-${process.pid}`;
  // Both specs own their rows; cleanup mirrors every registration.
  const createdUserIds: number[] = [];
  const createdWorkspaceIds: number[] = [];

  beforeAll(async () => {
    global.fetch = jest.fn(async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;

    // Boot the REAL AppModule — pipe/filter/guard enhancers register inside it
    // (conventions: enhancers stay at their registration site, no duplicates).
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    // Parser order mirrors main.ts: raw capture on /ingest, then the replay
    // route's wider JSON cap, then the global API default.
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use('/ingest', ingestRawBodyMiddleware());
    app.use('/api/records/:recordId/replay', express.json({ limit: MAX_BODY_BYTES }));
    app.use(express.json({ limit: '100kb' }));
    app.use(express.urlencoded({ extended: true }));
    await app.init();
  });

  afterAll(async () => {
    try {
      await app.close();
    } finally {
      global.fetch = originalFetch;
      // The specs own their rows: workspace delete cascades membership,
      // subscriber, records, and rate-limit windows; the user rows are next.
      const prisma = app.get(PrismaService);
      for (const id of createdWorkspaceIds) await prisma.workspace.delete({ where: { id } });
      for (const id of createdUserIds) await prisma.user.delete({ where: { id } });
      await prisma.$disconnect();
    }
  });

  // BUILD_PLAN P0: /health is liveness-only (200 while the process runs) and
  // /ready gates on `SELECT 1`. Unit specs pin the branches; this pins the
  // wiring — both routes reachable over real HTTP with the global pipe/filter.
  it('GET /health → 200 ok without touching the DB, GET /ready → 200 ready (DB is up here)', async () => {
    const health = await request(app.getHttpServer()).get('/health').expect(HttpStatus.OK);
    expect(health.body).toEqual({ status: 'ok' });

    const ready = await request(app.getHttpServer()).get('/ready').expect(HttpStatus.OK);
    expect(ready.body).toEqual({ status: 'ready' });
  });

  // L-4 end-to-end: genReqId (app.module) accepts a conservative charset and
  // the filter echoes the resulting req.id into the envelope; a crafted header
  // must be replaced by a fresh req_ id on BOTH layers.
  it('echoes a well-formed x-request-id into the error envelope and replaces a malformed one (L-4)', async () => {
    const good = await request(app.getHttpServer())
      .get('/api/no-such-route')
      .set('x-request-id', 'e2e-trace-42')
      .expect(HttpStatus.NOT_FOUND);
    expect(good.body.error.code).toBe('not_found');
    expect(good.body.error.requestId).toBe('e2e-trace-42');

    const bad = await request(app.getHttpServer())
      .get('/api/no-such-route')
      .set('x-request-id', 'bad id <script>')
      .expect(HttpStatus.NOT_FOUND);
    expect(bad.body.error.requestId).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('register → workspace → subscriber → signed POST /ingest/:token → 200 + record visible → replay → stats received unchanged → replay the replay row (chain, 02 §435)', async () => {
    const email = `e2e-${runId}@hooklab.test`;
    const password = 'correct-horse-1';

    // --- register ---
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password })
      .expect(HttpStatus.CREATED);
    expect(register.body.accessToken).toEqual(expect.any(String));
    createdUserIds.push(register.body.user.id as number);
    const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
    const token = register.body.accessToken as string;

    // --- create workspace ---
    const workspace = await request(app.getHttpServer())
      .post('/api/workspaces')
      .set(auth(token))
      .send({ name: `e2e-ws-${runId}` })
      .expect(HttpStatus.CREATED);
    expect(workspace.body.data.role).toBe('owner');
    const workspaceId = workspace.body.data.id as number;
    createdWorkspaceIds.push(workspaceId);

    // --- create subscriber (full secret only ever in THIS response) ---
    const subscriber = await request(app.getHttpServer())
      .post(`/api/workspaces/${workspaceId}/subscribers`)
      .set(auth(token))
      .send({
        name: `e2e-sub-${runId}`,
        // Loopback would be SSRF-blocked at replay time; a public IP literal
        // skips DNS and passes the blocklist, so the leg stays deterministic.
        destinationUrl: 'http://93.184.216.34/hook',
      })
      .expect(HttpStatus.CREATED);
    expect(subscriber.body.data.secret).toEqual(expect.any(String));
    expect(subscriber.body.data.ingestToken).toEqual(expect.any(String));
    const subscriberId = subscriber.body.data.id as number;
    const ingestToken = subscriber.body.data.ingestToken as string;
    const secret = subscriber.body.data.secret as string;
    const signatureHeader = subscriber.body.data.signatureHeader as string;

    // --- signed POST /ingest/:token — HMAC over the EXACT bytes on the wire ---
    const payload = { type: 'e2e.happy_path', runId };
    const rawBody = JSON.stringify(payload);
    const digest = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
    const ingest = await request(app.getHttpServer())
      .post(`/ingest/${ingestToken}`)
      .set(signatureHeader, `sha256=${digest}`)
      .set('content-type', 'application/json')
      .send(rawBody)
      .expect(HttpStatus.OK);
    expect(ingest.body.data).toEqual({ recordId: expect.any(Number), status: 'verified' });
    const recordId = ingest.body.data.recordId as number;

    // --- the record is visible in the subscriber list ---
    const list = await request(app.getHttpServer())
      .get(`/api/subscribers/${subscriberId}/records`)
      .set(auth(token))
      .expect(HttpStatus.OK);
    expect(list.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: recordId, status: 'verified', eventType: 'e2e.happy_path' }),
      ]),
    );

    const statsBefore = await request(app.getHttpServer())
      .get(`/api/subscribers/${subscriberId}/stats`)
      .set(auth(token))
      .expect(HttpStatus.OK);
    expect(statsBefore.body.data.received).toBe(1);
    expect(statsBefore.body.data.replays).toBe(0);

    // --- replay: 200 + a child row, but received count must NOT move ---
    const replay = await request(app.getHttpServer())
      .post(`/api/records/${recordId}/replay`)
      .set(auth(token))
      .send({ body: payload })
      .expect(HttpStatus.OK);
    expect(replay.body.data.outcome).toBe('ok');
    expect(replay.body.data.response.status).toBe(200);
    expect(replay.body.data.replayRecordId).toEqual(expect.any(Number));

    const statsAfter = await request(app.getHttpServer())
      .get(`/api/subscribers/${subscriberId}/stats`)
      .set(auth(token))
      .expect(HttpStatus.OK);
    expect(statsAfter.body.data.received).toBe(statsBefore.body.data.received);
    expect(statsAfter.body.data.verified).toBe(statsBefore.body.data.verified);
    expect(statsAfter.body.data.replays).toBe(1);

    // --- replay the replay row itself: 02 §435 allows chains, and the
    // canonical counts must not move when one is taken. ---
    const firstReplayId = replay.body.data.replayRecordId as number;
    const chain = await request(app.getHttpServer())
      .post(`/api/records/${firstReplayId}/replay`)
      .set(auth(token))
      .send({ body: payload })
      .expect(HttpStatus.OK);
    expect(chain.body.data.outcome).toBe('ok');
    const chainedId = chain.body.data.replayRecordId as number;
    expect(chainedId).not.toBe(firstReplayId);

    // The new row points at the row acted on (the replay), not the original.
    const chainedDetail = await request(app.getHttpServer())
      .get(`/api/records/${chainedId}`)
      .set(auth(token))
      .expect(HttpStatus.OK);
    expect(chainedDetail.body.data.replayOfId).toBe(firstReplayId);

    const statsChained = await request(app.getHttpServer())
      .get(`/api/subscribers/${subscriberId}/stats`)
      .set(auth(token))
      .expect(HttpStatus.OK);
    expect(statsChained.body.data.received).toBe(statsBefore.body.data.received);
    expect(statsChained.body.data.replays).toBe(2);
  }, 60_000);

  it('replays a >100kb body (the record was captured at the 1MB ingest cap, so replay must not die at the 100kb API default)', async () => {
    const email = `e2e-big-${runId}@hooklab.test`;
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-1' })
      .expect(HttpStatus.CREATED);
    createdUserIds.push(register.body.user.id as number);
    const auth = { Authorization: `Bearer ${register.body.accessToken as string}` };

    const workspace = await request(app.getHttpServer())
      .post('/api/workspaces')
      .set(auth)
      .send({ name: `e2e-big-ws-${runId}` })
      .expect(HttpStatus.CREATED);
    const workspaceId = workspace.body.data.id as number;
    createdWorkspaceIds.push(workspaceId);

    const subscriber = await request(app.getHttpServer())
      .post(`/api/workspaces/${workspaceId}/subscribers`)
      .set(auth)
      .send({ name: `e2e-big-sub-${runId}`, destinationUrl: 'http://93.184.216.34/hook' })
      .expect(HttpStatus.CREATED);
    const ingestToken = subscriber.body.data.ingestToken as string;
    const secret = subscriber.body.data.secret as string;
    const signatureHeader = subscriber.body.data.signatureHeader as string;

    // ~150KB: legal at ingest (MAX_BODY_BYTES = 1MB) but above the 100kb
    // global express.json default — exactly the window this pins.
    const bigPayload = { type: 'e2e.big_body', runId, blob: 'x'.repeat(150_000) };
    const rawBody = JSON.stringify(bigPayload);
    expect(Buffer.byteLength(rawBody)).toBeGreaterThan(100 * 1024);
    expect(Buffer.byteLength(rawBody)).toBeLessThan(MAX_BODY_BYTES);

    const digest = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
    const ingest = await request(app.getHttpServer())
      .post(`/ingest/${ingestToken}`)
      .set(signatureHeader, `sha256=${digest}`)
      .set('content-type', 'application/json')
      .send(rawBody)
      .expect(HttpStatus.OK);
    expect(ingest.body.data.status).toBe('verified');
    const recordId = ingest.body.data.recordId as number;

    // The edited body is the same order of magnitude, so the replay route must
    // parse at the capture cap and reach the service (200), not the parser (413).
    const edited = { ...bigPayload, blob: 'y'.repeat(150_000), edited: true };
    const replay = await request(app.getHttpServer())
      .post(`/api/records/${recordId}/replay`)
      .set(auth)
      .send({ body: edited })
      .expect(HttpStatus.OK);
    expect(replay.body.data.outcome).toBe('ok');

    // The outbound leg carried the EDITED bytes, not the original capture.
    const fetchMock = global.fetch as unknown as jest.Mock;
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    const sentBody = lastCall[1].body as string;
    expect(sentBody).toContain('"edited":true');
    expect(sentBody).toContain('yyyyyyyyyy');
  }, 60_000);

  it('rejects a replay body over the 1MB cap with 413 body_too_large and writes no replay row (02 §6)', async () => {
    const email = `e2e-413-${runId}@hooklab.test`;
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-1' })
      .expect(HttpStatus.CREATED);
    createdUserIds.push(register.body.user.id as number);
    const auth = { Authorization: `Bearer ${register.body.accessToken as string}` };

    const workspace = await request(app.getHttpServer())
      .post('/api/workspaces')
      .set(auth)
      .send({ name: `e2e-413-ws-${runId}` })
      .expect(HttpStatus.CREATED);
    const workspaceId = workspace.body.data.id as number;
    createdWorkspaceIds.push(workspaceId);

    const subscriber = await request(app.getHttpServer())
      .post(`/api/workspaces/${workspaceId}/subscribers`)
      .set(auth)
      .send({ name: `e2e-413-sub-${runId}`, destinationUrl: 'http://93.184.216.34/hook' })
      .expect(HttpStatus.CREATED);
    const subscriberId = subscriber.body.data.id as number;
    const ingestToken = subscriber.body.data.ingestToken as string;
    const secret = subscriber.body.data.secret as string;
    const signatureHeader = subscriber.body.data.signatureHeader as string;

    // A small valid capture to replay against.
    const rawBody = JSON.stringify({ type: 'e2e.oversize_replay', runId });
    const digest = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
    const ingest = await request(app.getHttpServer())
      .post(`/ingest/${ingestToken}`)
      .set(signatureHeader, `sha256=${digest}`)
      .set('content-type', 'application/json')
      .send(rawBody)
      .expect(HttpStatus.OK);
    const recordId = ingest.body.data.recordId as number;

    // Over MAX_BODY_BYTES: the replay route's express.json limit rejects this
    // before the handler runs — the parser answer is the whole contract (02 §6).
    const oversized = { type: 'e2e.oversize_replay', runId, blob: 'x'.repeat(MAX_BODY_BYTES) };
    expect(Buffer.byteLength(JSON.stringify({ body: oversized }))).toBeGreaterThan(MAX_BODY_BYTES);

    const replay = await request(app.getHttpServer())
      .post(`/api/records/${recordId}/replay`)
      .set(auth)
      .send({ body: oversized })
      .expect(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(replay.body.error.code).toBe('body_too_large');

    // Rejected before the handler: no replay row may exist, counts unmoved.
    const stats = await request(app.getHttpServer())
      .get(`/api/subscribers/${subscriberId}/stats`)
      .set(auth)
      .expect(HttpStatus.OK);
    expect(stats.body.data.replays).toBe(0);
    expect(stats.body.data.received).toBe(1);
  }, 60_000);

  // §8.2 rate-limit leg over real HTTP: RATE_LIMIT_MAX admitted, the next one
  // refused with 429 + Retry-After (RFC 9110 needs a non-zero delta-seconds).
  // The refusal still writes its rejected row (03 gate order: "429, record,
  // not counted" — counted means the WINDOW; the record is real and shows in stats).
  it(`rate-limits the ${RATE_LIMIT_MAX + 1}st ingest with 429 + Retry-After and records the refusal`, async () => {
    const email = `e2e-429-${runId}@hooklab.test`;
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-1' })
      .expect(HttpStatus.CREATED);
    createdUserIds.push(register.body.user.id as number);
    const auth = { Authorization: `Bearer ${register.body.accessToken as string}` };

    const workspace = await request(app.getHttpServer())
      .post('/api/workspaces')
      .set(auth)
      .send({ name: `e2e-429-ws-${runId}` })
      .expect(HttpStatus.CREATED);
    const workspaceId = workspace.body.data.id as number;
    createdWorkspaceIds.push(workspaceId);

    const subscriber = await request(app.getHttpServer())
      .post(`/api/workspaces/${workspaceId}/subscribers`)
      .set(auth)
      .send({ name: `e2e-429-sub-${runId}`, destinationUrl: 'http://93.184.216.34/hook' })
      .expect(HttpStatus.CREATED);
    const subscriberId = subscriber.body.data.id as number;
    const ingestToken = subscriber.body.data.ingestToken as string;
    const secret = subscriber.body.data.secret as string;
    const signatureHeader = subscriber.body.data.signatureHeader as string;

    const rawBody = JSON.stringify({ type: 'e2e.rate_limited', runId });
    const digest = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
    const send = () =>
      request(app.getHttpServer())
        .post(`/ingest/${ingestToken}`)
        .set(signatureHeader, `sha256=${digest}`)
        .set('content-type', 'application/json')
        .send(rawBody);

    for (let admitted = 0; admitted < RATE_LIMIT_MAX; admitted += 1) {
      await send().expect(HttpStatus.OK);
    }

    const refused = await send().expect(HttpStatus.TOO_MANY_REQUESTS);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toMatch(/^[1-9][0-9]*$/);

    const stats = await request(app.getHttpServer())
      .get(`/api/subscribers/${subscriberId}/stats`)
      .set(auth)
      .expect(HttpStatus.OK);
    expect(stats.body.data).toEqual(
      expect.objectContaining({
        received: RATE_LIMIT_MAX + 1,
        verified: RATE_LIMIT_MAX,
        rejected: 1,
        replays: 0,
        reasonBreakdown: expect.objectContaining({ rate_limited: 1 }),
      }),
    );
  }, 60_000);
});
