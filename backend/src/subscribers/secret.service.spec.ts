import { PrismaService } from '../common/prisma/prisma.service';
import { SecretService } from './secret.service';

const SUBSCRIBER_ID = 42;

interface TransactionMock {
  $executeRaw: jest.Mock;
  subscriber: { update: jest.Mock };
  rateLimitWindow: { deleteMany: jest.Mock };
}

interface PrismaHarness {
  prisma: PrismaService;
  tx: TransactionMock;
  $transaction: jest.Mock;
}

function makeHarness(): PrismaHarness {
  const tx: TransactionMock = {
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    subscriber: { update: jest.fn().mockResolvedValue({}) },
    rateLimitWindow: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const $transaction = jest.fn(
    async (fn: (inner: TransactionMock) => Promise<unknown>): Promise<unknown> => fn(tx),
  );
  return { prisma: { $transaction } as unknown as PrismaService, tx, $transaction };
}

describe('SecretService', () => {
  // generate()/hint() are pure — they never touch the client.
  const secrets = new SecretService({} as unknown as PrismaService);

  it('generate() emits a 32-byte hex token', () => {
    const first = secrets.generate();
    const second = secrets.generate();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(Buffer.from(first, 'hex')).toHaveLength(32);
  });

  it('hint() exposes only the last SECRET_HINT_LENGTH characters', () => {
    expect(secrets.hint('abcdef0123456789')).toBe('…6789');
    expect(secrets.hint('short')).toBe('…hort');
  });

  it('rotate runs lock → swap → window reset inside one $transaction', async () => {
    const { prisma, tx, $transaction } = makeHarness();
    const service = new SecretService(prisma);

    const rotated = await service.rotate(SUBSCRIBER_ID);

    expect($transaction).toHaveBeenCalledTimes(1);

    const lockTemplate = tx.$executeRaw.mock.calls[0][0] as TemplateStringsArray;
    expect(lockTemplate.join('')).toContain('pg_advisory_xact_lock');
    expect(tx.$executeRaw.mock.calls[0][1]).toBe(SUBSCRIBER_ID);

    const updateCall = tx.subscriber.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(updateCall.where).toEqual({ id: SUBSCRIBER_ID });
    expect(Object.keys(updateCall.data).sort()).toEqual(['hmacSecret', 'rotatedAt']);
    expect(updateCall.data.hmacSecret).toMatch(/^[0-9a-f]{64}$/);

    expect(tx.rateLimitWindow.deleteMany).toHaveBeenCalledWith({
      where: { subscriberId: SUBSCRIBER_ID },
    });

    // Same callback, strict order: the advisory lock guards the swap, and the
    // window drain lands after it so a concurrent ingest either lost the race
    // (old secret already gone) or re-seeds rows before the drain (row gone).
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.subscriber.update.mock.invocationCallOrder[0],
    );
    expect(tx.subscriber.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.rateLimitWindow.deleteMany.mock.invocationCallOrder[0],
    );

    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.secret).not.toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    expect(rotated.secretHint).toBe(`…${rotated.secret.slice(-4)}`);
    expect(rotated.rotatedAt).toBeInstanceOf(Date);
  });

  it('two rotations yield different secrets and hints track the current secret', async () => {
    const { prisma, tx } = makeHarness();
    const service = new SecretService(prisma);

    const first = await service.rotate(SUBSCRIBER_ID);
    const second = await service.rotate(SUBSCRIBER_ID);

    expect(first.secret).not.toBe(second.secret);
    expect(first.secretHint).toBe(`…${first.secret.slice(-4)}`);
    expect(second.secretHint).toBe(`…${second.secret.slice(-4)}`);
    expect(tx.subscriber.update).toHaveBeenCalledTimes(2);
  });
});
