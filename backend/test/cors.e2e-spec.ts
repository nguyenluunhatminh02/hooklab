import 'dotenv/config'; // CI sets DATABASE_URL workflow-wide; local runs need backend/.env
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { MAX_BODY_BYTES } from '../src/common/constants/ingest.constants';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ingestRawBodyMiddleware } from '../src/ingest/middleware/ingest-raw-body.middleware';

// BUILD_PLAN §6 binding rule: "CORS disabled app-wide; /api and /ingest are
// same-origin only; never enableCors(origin:true)+credentials." Every
// assertion below runs over real HTTP against the booted AppModule — a grant
// only shows up if the running server added it, so this pins behaviour, not
// source text.

/** A browser on another site — the origin the contract must never grant to. */
const CROSS_ORIGIN = 'https://evil.example';

const expectNoCorsGrant = (res: request.Response): void => {
  // ACAO is the grant that matters; ACAC is the pairing the binding rule
  // calls out by name (origin:true + credentials).
  expect(res.headers).not.toHaveProperty('access-control-allow-origin');
  expect(res.headers).not.toHaveProperty('access-control-allow-credentials');
};

describe('CORS-off contract (BUILD_PLAN §6 binding rule)', () => {
  let app: INestApplication;
  const runId = `${Date.now()}-${process.pid}`;
  const createdUserIds: number[] = [];
  const createdWorkspaceIds: number[] = [];

  beforeAll(async () => {
    // Boot the REAL AppModule with the same parser order main.ts uses (raw
    // capture on /ingest first, the replay route's wider JSON cap, then the
    // global API default) — a CORS middleware would register in this same
    // stack, so the wiring under test is the real one.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

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
      // The specs own their rows: workspace delete cascades membership,
      // subscriber, records, and rate-limit windows; the user rows are next.
      const prisma = app.get(PrismaService);
      for (const id of createdWorkspaceIds) await prisma.workspace.delete({ where: { id } });
      for (const id of createdUserIds) await prisma.user.delete({ where: { id } });
      await prisma.$disconnect();
    }
  });

  it('OPTIONS preflight to /api/auth/login from a foreign origin carries no ACAO, whatever its status', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', CROSS_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      // The status of an unpreflighted route is not part of this contract —
      // the headers are, so any answer must be inspected.
      .ok(() => true);

    expectNoCorsGrant(preflight);
  });

  it('GET /health with a foreign Origin carries no ACAO', async () => {
    const health = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', CROSS_ORIGIN)
      .expect(HttpStatus.OK);

    expectNoCorsGrant(health);
  });

  it('POST /api/auth/login carries no ACAO on its 400 (validation) and 401 (bad credentials) answers', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', CROSS_ORIGIN)
      .send({ email: 'not-an-email', password: '' })
      .expect(HttpStatus.BAD_REQUEST);
    expectNoCorsGrant(rejected);

    // Unknown email walks the same branch a wrong password would (401) — the
    // error answers are exactly where a CORS misconfig would still leak.
    const refused = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', CROSS_ORIGIN)
      .send({ email: `cors-nobody-${runId}@hooklab.test`, password: 'wrong-password-1' })
      .expect(HttpStatus.UNAUTHORIZED);
    expectNoCorsGrant(refused);
  });

  it('/ingest answers with no ACAO on preflight, unknown token (404), and a verified capture (200)', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/ingest/some-token')
      .set('Origin', CROSS_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .ok(() => true);
    expectNoCorsGrant(preflight);

    const unknown = await request(app.getHttpServer())
      .post('/ingest/no-such-token')
      .set('Origin', CROSS_ORIGIN)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'cors.unknown_token', runId }))
      .expect(HttpStatus.NOT_FOUND);
    expectNoCorsGrant(unknown);

    // The success answer must be same-origin too — that is the leg a browser
    // fetch would actually receive if the origin check were ever relaxed.
    const email = `e2e-cors-${runId}@hooklab.test`;
    const register = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-1' })
      .expect(HttpStatus.CREATED);
    createdUserIds.push(register.body.user.id as number);
    const auth = { Authorization: `Bearer ${register.body.accessToken as string}` };

    const workspace = await request(app.getHttpServer())
      .post('/api/workspaces')
      .set(auth)
      .send({ name: `e2e-cors-ws-${runId}` })
      .expect(HttpStatus.CREATED);
    createdWorkspaceIds.push(workspace.body.data.id as number);

    const subscriber = await request(app.getHttpServer())
      .post(`/api/workspaces/${workspace.body.data.id as number}/subscribers`)
      .set(auth)
      .send({
        name: `e2e-cors-sub-${runId}`,
        destinationUrl: 'http://93.184.216.34/hook',
      })
      .expect(HttpStatus.CREATED);
    const ingestToken = subscriber.body.data.ingestToken as string;
    const secret = subscriber.body.data.secret as string;
    const signatureHeader = subscriber.body.data.signatureHeader as string;

    const rawBody = JSON.stringify({ type: 'cors.verified_capture', runId });
    const digest = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
    const capture = await request(app.getHttpServer())
      .post(`/ingest/${ingestToken}`)
      .set('Origin', CROSS_ORIGIN)
      .set(signatureHeader, `sha256=${digest}`)
      .set('content-type', 'application/json')
      .send(rawBody)
      .expect(HttpStatus.OK);
    expectNoCorsGrant(capture);
  }, 60_000);
});
