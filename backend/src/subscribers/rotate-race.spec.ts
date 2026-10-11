import 'dotenv/config';
import { HttpStatus } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { IngestRequestInput, IngestService } from '../ingest/ingest.service';
import { RateLimitService } from '../ingest/rate-limit.service';
import { RejectReason, RecordStatus } from '../generated/prisma/enums';
import { verifySignature } from '../common/crypto/hmac';
import { SecretService } from './secret.service';

jest.setTimeout(60_000);

const SIGNATURE_HEADER = 'x-hub-signature-256';

describe('rotate vs ingest race (§8.2 — gates P2)', () => {
  let prisma: PrismaService;
  let secrets: SecretService;
  let ingest: IngestService;
  let workspaceId: number | undefined;
  let userId: number | undefined;
  const runId = `${Date.now()}-${process.pid}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    secrets = new SecretService(prisma);
    ingest = new IngestService(prisma, new RateLimitService(prisma));

    const user = await prisma.user.create({
      data: { email: `rotate-race-${runId}@hooklab.test`, passwordHash: 'spec-only-hash' },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({ data: { name: `rotate-race-${runId}` } });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    try {
      if (workspaceId !== undefined) {
        await prisma.workspace.delete({ where: { id: workspaceId } });
      }
      if (userId !== undefined) {
        await prisma.user.delete({ where: { id: userId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function createFixture(suffix: string): Promise<{
    id: number;
    token: string;
    secret: string;
  }> {
    const token = `race-token-${runId}-${suffix}`;
    const secret = `race-old-secret-${runId}-${suffix}`;
    const row = await prisma.subscriber.create({
      data: {
        workspaceId: workspaceId as number,
        name: `race-${suffix}-${runId}`,
        ingestToken: token,
        hmacSecret: secret,
        destinationUrl: 'https://example.test/hook',
      },
    });
    return { id: row.id, token, secret };
  }

  function signedInput(token: string, secret: string, seq: number): IngestRequestInput {
    const rawBody = Buffer.from(JSON.stringify({ type: 'race.probe', seq }));
    const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
    return {
      token,
      rawBody,
      bodyOverflow: false,
      method: 'POST',
      url: `https://sender.test/ingest/${token}`,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: `sha256=${digest}`,
      },
    };
  }

  it('rotate swaps the secret, keeps the token, and drains the window atomically', async () => {
    const fixture = await createFixture('swap');
    await prisma.rateLimitWindow.createMany({
      data: [1, 2, 3].map((secondsAgo) => ({
        subscriberId: fixture.id,
        occurredAt: new Date(Date.now() - secondsAgo * 1000),
      })),
    });

    const rotated = await secrets.rotate(fixture.id);

    // Window rows gone in the same callback-style $transaction (C5/§4.4).
    expect(
      await prisma.rateLimitWindow.count({ where: { subscriberId: fixture.id } }),
    ).toBe(0);

    const row = await prisma.subscriber.findUnique({ where: { id: fixture.id } });
    expect(row?.ingestToken).toBe(fixture.token);
    expect(row?.hmacSecret).toBe(rotated.secret);
    expect(row?.hmacSecret).not.toBe(fixture.secret);
    expect(row?.rotatedAt).toEqual(expect.any(Date));

    // Old secret fails verification the instant rotate resolves.
    const probeBody = Buffer.from('{"probe":true}');
    const oldHeader = `sha256=${createHmac('sha256', fixture.secret).update(probeBody).digest('hex')}`;
    const newHeader = `sha256=${createHmac('sha256', rotated.secret).update(probeBody).digest('hex')}`;
    expect(verifySignature(probeBody, oldHeader, rotated.secret)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
    expect(verifySignature(probeBody, newHeader, rotated.secret)).toEqual({ ok: true });
  });

  it('concurrent rotate: zero old-secret ingests succeed after the swap commits', async () => {
    const fixture = await createFixture('race');

    const inFlight = Array.from({ length: 10 }, (_, seq) =>
      ingest.handle(signedInput(fixture.token, fixture.secret, seq)),
    );
    const rotatePromise = (async () => {
      // Give the batch a turn to reach their first DB round trip so the
      // rotate genuinely interleaves with in-flight captures.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return secrets.rotate(fixture.id);
    })();

    const [outcomes, rotated] = await Promise.all([
      Promise.all(inFlight),
      rotatePromise,
    ]);
    expect(outcomes).toHaveLength(10);

    // Every concurrent outcome is a clean verdict — no crash mid-swap.
    // Partition the outcomes unconditionally: anything outside {200, 401}
    // surfaces as the offending rows themselves, and every 401 must carry
    // invalid_signature — a conditional assert would wave a 200 with a
    // failure shape straight through.
    const unexpected = outcomes.filter(
      (outcome) => outcome.status !== HttpStatus.OK && outcome.status !== HttpStatus.UNAUTHORIZED,
    );
    expect(unexpected).toEqual([]);
    const unauthorized = outcomes.filter((outcome) => outcome.status === HttpStatus.UNAUTHORIZED);
    expect(unauthorized.map((outcome) => outcome.reason)).toEqual(
      Array(unauthorized.length).fill('invalid_signature'),
    );

    // An old-secret success could only exist on captures that drained through
    // the advisory lock before rotate acquired it — all of those carry
    // receivedAt before rotatedAt. Nothing VERIFIED may sit after the swap.
    const verifiedAfterSwap = await prisma.webhookRecord.findMany({
      where: {
        subscriberId: fixture.id,
        status: RecordStatus.VERIFIED,
        receivedAt: { gt: rotated.rotatedAt },
      },
      select: { id: true },
    });
    expect(verifiedAfterSwap).toEqual([]);

    // Post-commit probes signed with the old secret: every one 401s and lands
    // as a REJECTED record (§4.2 state machine) — the secret died at commit.
    const probes = await Promise.all(
      [0, 1, 2].map((seq) => ingest.handle(signedInput(fixture.token, fixture.secret, 100 + seq))),
    );
    const probeRecordIds = probes.map((probe) => {
      if (probe.status !== HttpStatus.UNAUTHORIZED) {
        throw new Error(`post-rotate probe answered ${probe.status}, expected 401`);
      }
      expect(probe.reason).toBe('invalid_signature');
      return probe.recordId;
    });
    const probeRows = await prisma.webhookRecord.findMany({
      where: { id: { in: probeRecordIds } },
      select: { status: true, rejectReason: true },
    });
    expect(probeRows).toHaveLength(3);
    for (const row of probeRows) {
      expect(row.status).toBe(RecordStatus.REJECTED);
      expect(row.rejectReason).toBe(RejectReason.INVALID_SIGNATURE);
    }

    const unchanged = await prisma.subscriber.findUnique({ where: { id: fixture.id } });
    expect(unchanged?.ingestToken).toBe(fixture.token);
    expect(unchanged?.hmacSecret).toBe(rotated.secret);

    // Window drain holds: the advisory lock serializes acquire against rotate,
    // so a surviving row can only come from an admission that ran after the
    // swap committed — no pre-rotate row may outlive the deleteMany.
    const staleWindowRows = await prisma.rateLimitWindow.count({
      where: { subscriberId: fixture.id, occurredAt: { lt: rotated.rotatedAt } },
    });
    expect(staleWindowRows).toBe(0);
  });
});
