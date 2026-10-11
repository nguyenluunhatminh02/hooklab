import 'reflect-metadata';
import 'dotenv/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { RecordStatus, ReplayError } from '../generated/prisma/client';
import { LIST_LIMIT_DEFAULT } from '../common/constants/app.constants';
import { RecordsRepository } from './records.repository';

// Real PG: cursor stability under concurrent insert and meta.total through the
// canonical count are schema-level behaviours a mock cannot prove. CI deploys
// migrations before jest.
describe('RecordsRepository (real DB)', () => {
  let prisma: PrismaService;
  let repository: RecordsRepository;
  let workspaceId: number;
  let subscriberId: number;
  const runId = Date.now();
  const ingestToken = `records-repo-${runId}`;

  const MINUTE = 60_000;

  // o0 = newest original, o4 = oldest; all well inside the 7-day retention window
  // so a concurrent retention cron (03:00 UTC) cannot sweep these fixtures.
  const originalIds: number[] = [];
  let o0Id = 0;
  let o1Id = 0;
  let o2Id = 0;
  let o3Id = 0;
  let o4Id = 0;
  let replay1Id = 0;
  let replay2Id = 0;
  let headId = 0;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new RecordsRepository(prisma);

    const workspace = await prisma.workspace.create({ data: { name: 'records-repo-spec' } });
    workspaceId = workspace.id;
    const subscriber = await prisma.subscriber.create({
      data: {
        workspaceId,
        name: 'records-repo-spec',
        ingestToken,
        hmacSecret: 'spec-only-secret',
        destinationUrl: 'https://example.com/hook',
      },
    });
    subscriberId = subscriber.id;

    const now = Date.now();
    const seedRow = {
      subscriberId,
      method: 'POST',
      url: 'https://example.com/hook',
      headers: {} as Record<string, string>,
      rawBody: '{"kind":"spec"}',
      bodyBytes: 15,
    };

    const o0 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.VERIFIED,
        eventType: 'payment.succeeded',
        receivedAt: new Date(now - 5 * MINUTE),
      },
    });
    const o1 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.REJECTED,
        rejectReason: 'INVALID_SIGNATURE',
        eventType: 'payment.failed',
        receivedAt: new Date(now - 6 * MINUTE),
      },
    });
    const o2 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.VERIFIED,
        eventType: 'refund.created',
        receivedAt: new Date(now - 7 * MINUTE),
      },
    });
    const o3 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.VERIFIED,
        eventType: 'refund.created',
        receivedAt: new Date(now - 8 * MINUTE),
      },
    });
    const o4 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.VERIFIED,
        eventType: 'refund.created',
        receivedAt: new Date(now - 9 * MINUTE),
      },
    });
    o0Id = o0.id;
    o1Id = o1.id;
    o2Id = o2.id;
    o3Id = o3.id;
    o4Id = o4.id;
    originalIds.push(o0Id, o1Id, o2Id, o3Id, o4Id);

    const replay1 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.VERIFIED,
        eventType: 'payment.succeeded',
        replayOfId: o0Id,
        replayTargetUrl: 'https://example.com/hook',
        responseStatus: 200,
        responseBody: '{"ok":true}',
        replayError: null,
        replayedAt: new Date(now - 4 * MINUTE),
        durationMs: 12,
        receivedAt: new Date(now - 4 * MINUTE),
      },
    });
    const replay2 = await prisma.webhookRecord.create({
      data: {
        ...seedRow,
        status: RecordStatus.VERIFIED,
        eventType: 'payment.succeeded',
        replayOfId: o0Id,
        replayTargetUrl: 'https://example.com/hook',
        responseStatus: null,
        responseBody: null,
        replayError: ReplayError.REPLAY_TIMEOUT,
        replayedAt: new Date(now - 3 * MINUTE),
        durationMs: 10_000,
        receivedAt: new Date(now - 3 * MINUTE),
      },
    });
    replay1Id = replay1.id;
    replay2Id = replay2.id;
  });

  afterAll(async () => {
    try {
      await prisma.webhookRecord.deleteMany({
        where: { id: { in: [...originalIds, replay1Id, replay2Id, headId].filter((id) => id !== 0) } },
      });
      await prisma.subscriber.delete({ where: { id: subscriberId } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('stats: received/verified/rejected ignore replays; replays counted separately', async () => {
    const stats = await repository.stats(subscriberId);
    expect(stats.received).toBe(5);
    expect(stats.verified).toBe(4);
    expect(stats.rejected).toBe(1);
    expect(stats.replays).toBe(2);
    expect(stats.reasonBreakdown).toEqual({
      missing_signature: 0,
      invalid_signature: 1,
      rate_limited: 0,
      body_too_large: 0,
    });
    expect(stats.retention.days).toBe(7);
    expect(stats.retention.notice).toBe('records auto-delete after 7 days');
    // oldest original is ~9 min old — well inside retention, so the floor is the row itself.
    const oldestOriginal = await prisma.webhookRecord.findFirst({
      where: { subscriberId, replayOfId: null },
      orderBy: { receivedAt: 'asc' },
    });
    expect(stats.retention.oldestKeptAt).toBe(oldestOriginal?.receivedAt.toISOString());
  });

  it('default listing excludes replays; includeReplays=true surfaces them with isReplay', async () => {
    const defaultPage = await repository.listForSubscriber(subscriberId, {});
    expect(defaultPage.data).toHaveLength(5);
    expect(defaultPage.data.every((item) => !item.isReplay)).toBe(true);
    expect(defaultPage.data.every((item) => item.replayOfId === null)).toBe(true);
    expect(defaultPage.data.map((item) => item.id)).toEqual([o0Id, o1Id, o2Id, o3Id, o4Id]);

    const withReplays = await repository.listForSubscriber(subscriberId, { includeReplays: true });
    expect(withReplays.data).toHaveLength(7);
    const replayItems = withReplays.data.filter((item) => item.isReplay);
    expect(replayItems.map((item) => item.id).sort()).toEqual([replay1Id, replay2Id].sort());
    expect(replayItems.every((item) => item.replayOfId === o0Id)).toBe(true);
    // Replay rows carry the outbound leg's status on the wire.
    const timeoutRow = replayItems.find((item) => item.id === replay2Id);
    expect(timeoutRow?.replayResponseStatus).toBeNull();
    const okRow = replayItems.find((item) => item.id === replay1Id);
    expect(okRow?.replayResponseStatus).toBe(200);
  });

  it('offset mode reports meta.total from the canonical count, never the raw table', async () => {
    const page = await repository.listForSubscriber(subscriberId, { offset: 0, limit: 2 });
    expect(page.meta.total).toBe(5);
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.nextCursor).toBeNull();
    expect(page.data).toHaveLength(2);

    const lastPage = await repository.listForSubscriber(subscriberId, { offset: 4, limit: 2 });
    expect(lastPage.meta.total).toBe(5);
    expect(lastPage.data).toHaveLength(1);
    expect(lastPage.meta.hasMore).toBe(false);
  });

  it('cursor paging stays stable when a new record lands at the head', async () => {
    const page1 = await repository.listForSubscriber(subscriberId, { limit: 2 });
    expect(page1.data.map((item) => item.id)).toEqual([o0Id, o1Id]);
    expect(page1.meta.hasMore).toBe(true);
    expect(page1.meta.nextCursor).not.toBeNull();

    // Insert-at-head BETWEEN the two page fetches — the classic offset-paging bug.
    const head = await prisma.webhookRecord.create({
      data: {
        subscriberId,
        method: 'POST',
        url: 'https://example.com/hook',
        headers: {},
        rawBody: '{"kind":"head"}',
        bodyBytes: 13,
        status: RecordStatus.VERIFIED,
        eventType: 'ping.created',
        receivedAt: new Date(),
      },
    });
    headId = head.id;

    const page2 = await repository.listForSubscriber(subscriberId, {
      limit: 2,
      cursor: page1.meta.nextCursor ?? undefined,
    });
    // The head row is newer than the cursor and must not shift page2; the two
    // pages are disjoint and nothing between the cursor and o3 is skipped.
    expect(page2.data.map((item) => item.id)).toEqual([o2Id, o3Id]);
    expect(page2.data.some((item) => item.id === headId)).toBe(false);
    expect(page2.data.some((item) => item.id === o0Id)).toBe(false);
    expect(page2.meta.hasMore).toBe(true);
  });

  it('status filter narrows both the default and the replay-inclusive view', async () => {
    const rejectedOnly = await repository.listForSubscriber(subscriberId, { status: RecordStatus.REJECTED });
    expect(rejectedOnly.data.map((item) => item.id)).toEqual([o1Id]);
    expect(rejectedOnly.data[0]?.reason).toBe('invalid_signature');

    const verifiedWithReplays = await repository.listForSubscriber(subscriberId, {
      status: RecordStatus.VERIFIED,
      includeReplays: true,
    });
    expect(verifiedWithReplays.data.every((item) => item.status === 'verified')).toBe(true);
    expect(verifiedWithReplays.data.some((item) => item.isReplay)).toBe(true);
  });

  it('q filters by case-insensitive eventType substring', async () => {
    const payment = await repository.listForSubscriber(subscriberId, { q: 'PAYMENT.SUCCEEDED' });
    expect(payment.data.map((item) => item.id)).toEqual([o0Id]);

    const none = await repository.listForSubscriber(subscriberId, { q: 'no-such-event-kind' });
    expect(none.data).toEqual([]);
  });

  it('q also prefix-matches ingestToken on the workspace route', async () => {
    const page = await repository.listForWorkspace(workspaceId, { q: `records-repo-${runId}` });
    // Every row of this fixture belongs to that subscriber — the token prefix
    // matches, so the page is non-empty; a wrong prefix yields nothing.
    expect(page.data.length).toBeGreaterThan(0);
    const wrong = await repository.listForWorkspace(workspaceId, { q: `records-repo-${runId}-nope` });
    expect(wrong.data).toEqual([]);
  });

  it('rejects cursor+offset together and a malformed cursor', async () => {
    await expect(
      repository.listForSubscriber(subscriberId, { cursor: 'not-a-real-cursor', offset: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(repository.listForSubscriber(subscriberId, { cursor: 'not-a-real-cursor' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('falls back to LIST_LIMIT_DEFAULT when limit is omitted', async () => {
    // Count the fixture's originals instead of hardcoding a length: the cursor
    // test inserts an extra head row, and this assertion must not depend on
    // another test's leftovers.
    const expectedOriginals = await prisma.webhookRecord.count({
      where: { subscriberId, replayOfId: null },
    });
    const page = await repository.listForSubscriber(subscriberId, {});
    expect(page.data).toHaveLength(Math.min(LIST_LIMIT_DEFAULT, expectedOriginals));
    expect(page.meta.hasMore).toBe(false);
    expect(page.meta.nextCursor).toBeNull();
  });
});
