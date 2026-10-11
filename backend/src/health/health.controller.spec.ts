import { ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { HealthController } from './health.controller';

// C19 / BUILD_PLAN P0 acceptance: /health is liveness-only (always 200 while
// the process runs) and /ready gates on `SELECT 1` — 503 until the DB answers.
// Mock PrismaService by token (conventions §3) so no DB is needed here.
describe('HealthController', () => {
  let controller: HealthController;
  const queryRaw = jest.fn();

  beforeEach(async () => {
    queryRaw.mockReset();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('health() reports ok without touching the database (liveness)', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('ready() reports ready when SELECT 1 succeeds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('ready() throws 503 when the database is unreachable', async () => {
    queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
