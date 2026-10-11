import 'reflect-metadata';
import 'dotenv/config';
import { PrismaService } from './prisma.service';
import { RecordStatus } from '../../generated/prisma/client';
import { receivedWhere } from './record-count';

describe('receivedWhere (replayOfId leak regression, BUILD_PLAN §8.1)', () => {
  let prisma: PrismaService;
  let workspaceId: number;
  let subscriberId: number;
  let originalId: number;
  let replay1Id: number;
  let replay2Id: number;
  const runId = Date.now();
  const email = `rc-${runId}@test.local`;
  const ingestToken = `rc-${runId}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    const originalHeaders = { 'x-request-id': 'orig' };

    const user = await prisma.user.create({ data: { email, passwordHash: 'spec-only-hash' } });
    const workspace = await prisma.workspace.create({ data: { name: 'record-count-spec' } });
    workspaceId = workspace.id;
    await prisma.membership.create({
      data: { workspaceId, userId: user.id, role: 'OWNER' },
    });
    const subscriber = await prisma.subscriber.create({
      data: {
        workspaceId,
        name: 'record-count-spec',
        ingestToken,
        hmacSecret: 'spec-only-secret',
        destinationUrl: 'https://example.com/hook',
      },
    });
    subscriberId = subscriber.id;

    const original = await prisma.webhookRecord.create({
      data: {
        subscriberId,
        method: 'POST',
        url: 'https://example.com/hook',
        headers: originalHeaders,
        rawBody: JSON.stringify({ n: 1 }),
        bodyBytes: 8,
        status: RecordStatus.VERIFIED,
        eventType: 'test.event',
      },
    });
    originalId = original.id;

    const replay1 = await prisma.webhookRecord.create({
      data: {
        subscriberId,
        method: original.method,
        url: original.url,
        headers: originalHeaders,
        rawBody: original.rawBody,
        bodyBytes: original.bodyBytes,
        status: RecordStatus.VERIFIED,
        eventType: original.eventType,
        replayOfId: original.id,
        replayTargetUrl: subscriber.destinationUrl,
        responseStatus: 200,
        responseBody: '{"ok":true}',
        replayedAt: new Date(),
        durationMs: 5,
      },
    });
    replay1Id = replay1.id;

    const replay2 = await prisma.webhookRecord.create({
      data: {
        subscriberId,
        method: original.method,
        url: original.url,
        headers: originalHeaders,
        rawBody: original.rawBody,
        bodyBytes: original.bodyBytes,
        status: RecordStatus.VERIFIED,
        eventType: original.eventType,
        replayOfId: original.id,
        replayTargetUrl: subscriber.destinationUrl,
        responseStatus: 204,
        responseBody: null,
        replayedAt: new Date(),
        durationMs: 7,
      },
    });
    replay2Id = replay2.id;
  });

  afterAll(async () => {
    try {
      await prisma.webhookRecord.deleteMany({ where: { id: { in: [originalId, replay1Id, replay2Id] } } });
      await prisma.subscriber.delete({ where: { id: subscriberId } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { email } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('received counts exclude replays; the replay view counts them (replayOfId leak)', async () => {
    // Canonical helper — the assertion that fails the moment the filter drops
    // `replayOfId: null` (proven RED in the bug-fix protocol run).
    const received = await prisma.webhookRecord.count({ where: receivedWhere({ subscriberId }) });
    expect(received).toBe(1);

    const verified = await prisma.webhookRecord.count({
      where: receivedWhere({ subscriberId, status: RecordStatus.VERIFIED }),
    });
    expect(verified).toBe(1);

    const rejected = await prisma.webhookRecord.count({
      where: receivedWhere({ subscriberId, status: RecordStatus.REJECTED }),
    });
    expect(rejected).toBe(0);

    // Default timeline listing must show exactly the original.
    const timeline = await prisma.webhookRecord.findMany({
      where: receivedWhere({ subscriberId }),
      orderBy: { receivedAt: 'desc' },
    });
    expect(timeline.map((row) => row.id)).toEqual([originalId]);

    // The full subscriber view (includeReplays) sees all three rows.
    const withReplays = await prisma.webhookRecord.findMany({ where: { subscriberId } });
    expect(withReplays).toHaveLength(3);

    // Replays stat: replayOfId != null, not the canonical filter.
    const replays = await prisma.webhookRecord.count({
      where: { subscriberId, replayOfId: { not: null } },
    });
    expect(replays).toBe(2);
  });

  it('stats-shaped counts are unchanged by the two replay rows', async () => {
    const receivedBefore = await prisma.webhookRecord.count({ where: receivedWhere({ subscriberId }) });
    const verifiedBefore = await prisma.webhookRecord.count({
      where: receivedWhere({ subscriberId, status: RecordStatus.VERIFIED }),
    });

    await prisma.webhookRecord.create({
      data: {
        subscriberId,
        method: 'POST',
        url: 'https://example.com/hook',
        headers: {},
        rawBody: '{}',
        bodyBytes: 2,
        status: RecordStatus.VERIFIED,
        replayOfId: originalId,
        replayTargetUrl: 'https://example.com/hook',
        responseStatus: 200,
        responseBody: 'ok',
        replayedAt: new Date(),
        durationMs: 3,
      },
    });

    const receivedAfter = await prisma.webhookRecord.count({ where: receivedWhere({ subscriberId }) });
    const verifiedAfter = await prisma.webhookRecord.count({
      where: receivedWhere({ subscriberId, status: RecordStatus.VERIFIED }),
    });
    expect(receivedAfter).toBe(receivedBefore);
    expect(verifiedAfter).toBe(verifiedBefore);
    expect(receivedAfter).toBe(1);
    expect(verifiedAfter).toBe(1);

    const replaysAfter = await prisma.webhookRecord.count({
      where: { subscriberId, replayOfId: { not: null } },
    });
    expect(replaysAfter).toBe(3);
  });
});
