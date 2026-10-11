import 'reflect-metadata';
import 'dotenv/config';

import { Test, type TestingModule } from '@nestjs/testing';
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../common/constants/ingest.constants';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimitService } from './rate-limit.service';

jest.setTimeout(30_000);

type TxMock = {
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
  rateLimitWindow: {
    findMany: jest.Mock;
    create: jest.Mock;
  };
};

function makeTx(clockTimes: Date[]): TxMock {
  const queryRaw = jest.fn();
  for (const t of clockTimes) {
    queryRaw.mockResolvedValueOnce([{ dbNow: t }]);
  }
  return {
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $queryRaw: queryRaw,
    rateLimitWindow: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
    },
  };
}

function makeService(tx: TxMock): RateLimitService {
  const prisma = {
    $transaction: jest.fn(async <T>(fn: (t: TxMock) => Promise<T>) => fn(tx)),
  } as unknown as PrismaService;
  return new RateLimitService(prisma);
}

function rowsAt(offsetsMs: number[], base: Date): Array<{ occurredAt: Date }> {
  return offsetsMs.map((offset) => ({ occurredAt: new Date(base.getTime() - offset) }));
}

function filledWindowOffsets(count: number, spacingMs = 1000): number[] {
  return Array.from({ length: count }, (_, i) => i * spacingMs);
}

describe('RateLimitService (unit)', () => {
  const SUBSCRIBER_ID = 42;
  const NOW = new Date('2026-10-08T12:00:00.000Z');

  it('takes pg_advisory_xact_lock keyed by subscriberId inside the transaction', async () => {
    const tx = makeTx([NOW]);
    await makeService(tx).acquire(SUBSCRIBER_ID);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual([SUBSCRIBER_ID]);
  });

  it('admits when the window holds RATE_LIMIT_MAX - 1 rows and inserts exactly one', async () => {
    const tx = makeTx([NOW]);
    tx.rateLimitWindow.findMany.mockResolvedValueOnce(
      rowsAt(filledWindowOffsets(RATE_LIMIT_MAX - 1), NOW),
    );

    const decision = await makeService(tx).acquire(SUBSCRIBER_ID);

    expect(decision).toEqual({ admitted: true });
    expect(tx.rateLimitWindow.findMany).toHaveBeenCalledWith({
      where: {
        subscriberId: SUBSCRIBER_ID,
        occurredAt: { gt: new Date(NOW.getTime() - RATE_LIMIT_WINDOW_MS) },
      },
      select: { occurredAt: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(tx.rateLimitWindow.create).toHaveBeenCalledTimes(1);
    expect(tx.rateLimitWindow.create).toHaveBeenCalledWith({
      data: { subscriberId: SUBSCRIBER_ID },
    });
    // Admit path never consults the respond clock a second time.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('uses a strict `>` cutoff — a row exactly WINDOW_MS old is outside the window', async () => {
    const tx = makeTx([NOW]);
    tx.rateLimitWindow.findMany.mockResolvedValueOnce([]);

    await makeService(tx).acquire(SUBSCRIBER_ID);

    const call = tx.rateLimitWindow.findMany.mock.calls[0][0] as {
      where: { occurredAt: { gt: Date } };
    };
    expect(call.where.occurredAt.gt).toEqual(new Date(NOW.getTime() - RATE_LIMIT_WINDOW_MS));
  });

  it('rejects when the window is full and never inserts a window row', async () => {
    const tx = makeTx([NOW, NOW]);
    tx.rateLimitWindow.findMany.mockResolvedValueOnce(
      rowsAt(filledWindowOffsets(RATE_LIMIT_MAX), NOW),
    );

    const decision = await makeService(tx).acquire(SUBSCRIBER_ID);

    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    // A 429 must not count against the window it was refused by.
    expect(tx.rateLimitWindow.create).not.toHaveBeenCalled();
    // Reject path re-reads the respond clock.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('computes Retry-After from the oldest row, ceil\'d to whole seconds', async () => {
    const oldestAgeMs = RATE_LIMIT_WINDOW_MS - 2500; // 2.5s left → ceil = 3
    const tx = makeTx([NOW, NOW]);
    tx.rateLimitWindow.findMany.mockResolvedValueOnce(
      rowsAt([oldestAgeMs, ...filledWindowOffsets(RATE_LIMIT_MAX - 1)], NOW),
    );

    const decision = await makeService(tx).acquire(SUBSCRIBER_ID);

    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.retryAfterSeconds).toBe(3);
    }
  });

  it('clamps Retry-After to ≥ 1 when the ceiling lands on 0', async () => {
    // Oldest expired 500ms before the first clock; the respond clock is 1s
    // later, so msLeft is deeply negative → ceil is ≤ 0 → clamp to 1.
    const tx = makeTx([NOW, new Date(NOW.getTime() + 1000)]);
    tx.rateLimitWindow.findMany.mockResolvedValueOnce(
      rowsAt([RATE_LIMIT_WINDOW_MS - 500, ...filledWindowOffsets(RATE_LIMIT_MAX - 1)], NOW),
    );

    const decision = await makeService(tx).acquire(SUBSCRIBER_ID);

    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.retryAfterSeconds).toBe(1);
    }
  });
});

describe('RateLimitService (real PostgreSQL)', () => {
  // Real PG: the advisory lock and the sliding window are server-side
  // behaviour a mock cannot prove. CI deploys migrations before jest.
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: RateLimitService;
  let subscriberId: number | undefined;
  let workspaceId: number | undefined;
  let userId: number | undefined;

  const runId = `${Date.now()}-${process.pid}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [RateLimitService, PrismaService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(RateLimitService);

    const user = await prisma.user.create({
      data: { email: `rl-${runId}@hooklab.test`, passwordHash: 'spec-only-hash' },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({ data: { name: `rl-${runId}` } });
    workspaceId = workspace.id;
    const subscriber = await prisma.subscriber.create({
      data: {
        workspaceId: workspace.id,
        name: `rl-sub-${runId}`,
        ingestToken: `tok-${runId}`,
        hmacSecret: `secret-${runId}`,
        destinationUrl: 'https://example.test/hook',
      },
    });
    subscriberId = subscriber.id;
  });

  afterAll(async () => {
    if (workspaceId !== undefined) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (userId !== undefined) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await moduleRef.close();
  });

  beforeEach(async () => {
    const id = requireSubscriberId();
    await prisma.rateLimitWindow.deleteMany({ where: { subscriberId: id } });
  });

  async function dbNow(): Promise<Date> {
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    return rows[0].now;
  }

  function requireSubscriberId(): number {
    if (subscriberId === undefined) {
      throw new Error('seed failed: no subscriberId');
    }
    return subscriberId;
  }

  it('admits when one window row is exactly WINDOW_MS old (boundary, excluded)', async () => {
    const id = requireSubscriberId();
    const now = await dbNow();
    const excluded = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
    const inside = Array.from({ length: RATE_LIMIT_MAX - 1 }, () => new Date(now.getTime() - 30_000));
    await prisma.rateLimitWindow.createMany({
      data: [
        { subscriberId: id, occurredAt: excluded },
        ...inside.map((occurredAt) => ({ subscriberId: id, occurredAt })),
      ],
    });

    const decision = await service.acquire(id);

    expect(decision).toEqual({ admitted: true });
    // The excluded boundary row stays on the table; only the admitted insert
    // is new — 59 inside + 1 boundary + 1 admitted = 61.
    const count = await prisma.rateLimitWindow.count({ where: { subscriberId: id } });
    expect(count).toBe(RATE_LIMIT_MAX + 1);
  });

  it('rejects when the window is full of rows still inside 60s (included)', async () => {
    const id = requireSubscriberId();
    const now = await dbNow();
    // 30s old: unambiguously inside the 60s window, and leaves 30s of drift
    // budget between this seed and the service's own now() read. The previous
    // 59_900ms seed left only 100ms and lost the race under a loaded parallel
    // suite (flaky). Exact-boundary semantics are pinned by the test above;
    // this one only needs rows that are plainly inside.
    await prisma.rateLimitWindow.createMany({
      data: Array.from({ length: RATE_LIMIT_MAX }, () => ({
        subscriberId: id,
        occurredAt: new Date(now.getTime() - 30_000),
      })),
    });
    const before = await prisma.rateLimitWindow.count({ where: { subscriberId: id } });

    const decision = await service.acquire(id);

    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    const after = await prisma.rateLimitWindow.count({ where: { subscriberId: id } });
    expect(after).toBe(before);
  });

  it('admits exactly 5 of 10 parallel attempts when 55 slots are already used', async () => {
    const id = requireSubscriberId();
    const EXPECTED_ADMITTED = 5;
    const PARALLEL_ATTEMPTS = 10;
    const SEEDED_WINDOW_ROWS = RATE_LIMIT_MAX - EXPECTED_ADMITTED;

    await prisma.rateLimitWindow.createMany({
      data: Array.from({ length: SEEDED_WINDOW_ROWS }, () => ({ subscriberId: id })),
    });

    const decisions = await Promise.all(
      Array.from({ length: PARALLEL_ATTEMPTS }, () => service.acquire(id)),
    );

    const admitted = decisions.filter((d) => d.admitted).length;
    expect(admitted).toBe(EXPECTED_ADMITTED);
    const count = await prisma.rateLimitWindow.count({ where: { subscriberId: id } });
    expect(count).toBe(RATE_LIMIT_MAX);
    for (const decision of decisions) {
      if (!decision.admitted) {
        expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
