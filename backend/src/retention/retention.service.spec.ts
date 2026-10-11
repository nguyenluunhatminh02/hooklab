import 'reflect-metadata'; // decorator-metadata assertions read Reflect.getMetadata before Nest boots
import 'dotenv/config'; // CI sets DATABASE_URL as workflow env; local runs need backend/.env (dotenv never overrides an already-set var)

import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { MS_PER_DAY } from '../common/constants/app.constants';
import { RATE_LIMIT_WINDOW_MS, RETENTION_DAYS } from '../common/constants/ingest.constants';
import { PrismaService } from '../common/prisma/prisma.service';
import { RecordStatus } from '../generated/prisma/client';
import {
  RETENTION_CRON_EXPRESSION,
  RETENTION_CRON_NAME,
  RETENTION_CRON_TIME_ZONE,
} from './retention.constants';
import { RetentionService } from './retention.service';

// @nestjs/schedule writes decorator metadata on the method function under these
// keys; the package barrel (index.d.ts) re-exports only decorators/enums/module,
// so the keys are named here instead of deep-importing dist internals.
const CRON_OPTIONS_KEY = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULER_NAME_KEY = 'SCHEDULER_NAME';

jest.setTimeout(15_000);

describe('RetentionService', () => {
  describe('cron registration (C7)', () => {
    const cronTarget: object = RetentionService.prototype.purgeExpiredRecords;

    it('registers exactly one cron handler — the sweep must not fire twice', () => {
      const prototype = RetentionService.prototype as unknown as Record<string, unknown>;
      const cronMethods = Object.getOwnPropertyNames(prototype).filter(
        (method) => Reflect.getMetadata(CRON_OPTIONS_KEY, prototype[method] as object) !== undefined,
      );
      expect(cronMethods).toEqual(['purgeExpiredRecords']);
    });

    it('is a job named "retention"', () => {
      // No SCHEDULER_TYPE check: the v5 barrel exports neither the SchedulerType
      // enum nor a path to it (dist/enums/index re-exports CronExpression only),
      // so the deep import it used to make is gone — the registry spec below
      // proves cron-ness harder, by observing what the scheduler registered.
      expect(Reflect.getMetadata(SCHEDULER_NAME_KEY, cronTarget)).toBe(RETENTION_CRON_NAME);
    });

    it('fires daily 03:00:00 UTC — expression asserted field by field', () => {
      const options = Reflect.getMetadata(CRON_OPTIONS_KEY, cronTarget);
      expect(options.timeZone).toBe(RETENTION_CRON_TIME_ZONE);
      expect(options.timeZone).toBe('UTC');

      const fields: unknown[] = String(options.cronTime).split(' ');
      expect(fields).toHaveLength(6); // a 5-field expression has no seconds column
      const [seconds, minutes, hours, dayOfMonth, month, dayOfWeek] = fields;
      expect({ seconds, minutes, hours, dayOfMonth, month, dayOfWeek }).toEqual({
        seconds: '0',
        minutes: '0',
        hours: '3',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*',
      });
      expect(options.cronTime).toBe('0 0 3 * * *');
      expect(options.cronTime).toBe(RETENTION_CRON_EXPRESSION);
    });
  });

  // Decorator metadata above is invariant to the module graph: a second
  // ScheduleModule.forRoot(), or RetentionModule dropped from AppModule, would
  // leave every assertion there green. Booting the real app and reading the
  // registry is what pins "cron fires once (UTC)" to the wiring, and it also
  // exercises CronJob.from, which throws if the expression fails to parse.
  describe('registered cron jobs in a booted AppModule (C7)', () => {
    let moduleRef: TestingModule;
    let registry: SchedulerRegistry;

    beforeAll(async () => {
      // Boots the full AppModule, so every service that validates env at
      // construction must find its vars. CI has no backend/.env — the
      // fallbacks keep this spec bootable in a bare env (JwtStrategy wants the
      // secret, SubscribersService wants PUBLIC_BASE_URL for endpointUrl).
      process.env.JWT_SECRET ??= 'retention-registry-spec-secret-0123456789';
      process.env.PUBLIC_BASE_URL ??= 'http://hooklab.test';
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init(); // ScheduleModule mounts cron jobs on bootstrap
      registry = moduleRef.get(SchedulerRegistry);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('registers exactly one cron job, under the name "retention" — no duplicate forRoot(), no dropped RetentionModule', () => {
      expect([...registry.getCronJobs().keys()]).toEqual([RETENTION_CRON_NAME]);
      expect(registry.getCronJob(RETENTION_CRON_NAME)).toBeDefined();
    });

    it('the live job carries the 03:00 UTC expression the scheduler actually parsed', () => {
      expect(registry.getCronJob(RETENTION_CRON_NAME).cronTime.source).toBe(
        RETENTION_CRON_EXPRESSION,
      );
    });

    it('fires the registered cron job end-to-end: the live purge sweeps, cascades, prunes and logs its count', async () => {
      const prisma = moduleRef.get(PrismaService);
      const runId = `retention-cron-fire-spec-${Date.now()}`;
      // Same slack as the sibling live-database describe: keeps a boundary
      // row's fate from flipping on the milliseconds between seeding and the
      // sweep, which cuts its own time from the database clock.
      const CLOCK_SLACK_MS = 60_000;
      let workspaceId: number | undefined;
      let userId: number | undefined;

      try {
        const now = Date.now();
        const user = await prisma.user.create({
          data: { email: `${runId}@example.test`, passwordHash: 'spec-only-hash' },
        });
        userId = user.id;
        const workspace = await prisma.workspace.create({ data: { name: runId } });
        workspaceId = workspace.id;
        const subscriber = await prisma.subscriber.create({
          data: {
            workspaceId: workspace.id,
            name: runId,
            ingestToken: runId,
            hmacSecret: 'spec-only-secret',
            destinationUrl: 'https://example.com/hook',
          },
        });

        const seedRow = {
          subscriberId: subscriber.id,
          method: 'POST',
          url: 'https://example.com/hook',
          headers: {},
          rawBody: '{}',
          status: RecordStatus.VERIFIED,
          bodyBytes: 2,
        };

        const beyondCutoff = await prisma.webhookRecord.create({
          data: { ...seedRow, receivedAt: new Date(now - (RETENTION_DAYS + 1) * MS_PER_DAY) },
        });
        const deepPast = await prisma.webhookRecord.create({
          data: { ...seedRow, receivedAt: new Date(now - (RETENTION_DAYS + 2) * MS_PER_DAY) },
        });
        const pastEdge = await prisma.webhookRecord.create({
          data: {
            ...seedRow,
            receivedAt: new Date(now - RETENTION_DAYS * MS_PER_DAY - CLOCK_SLACK_MS),
          },
        });
        const expiredRecordIds = [beyondCutoff.id, deepPast.id, pastEdge.id];

        const young = await prisma.webhookRecord.create({
          data: { ...seedRow, receivedAt: new Date(now - MS_PER_DAY) },
        });
        const withinEdge = await prisma.webhookRecord.create({
          data: {
            ...seedRow,
            receivedAt: new Date(now - RETENTION_DAYS * MS_PER_DAY + CLOCK_SLACK_MS),
          },
        });

        // Replay children younger than the cutoff: only the FK cascade removes them.
        const replayOfExpired = await prisma.webhookRecord.create({
          data: { ...seedRow, replayOfId: beyondCutoff.id, receivedAt: new Date(now) },
        });
        const replayOfYoung = await prisma.webhookRecord.create({
          data: { ...seedRow, replayOfId: young.id, receivedAt: new Date(now) },
        });

        await prisma.rateLimitWindow.create({
          data: {
            subscriberId: subscriber.id,
            occurredAt: new Date(now - RATE_LIMIT_WINDOW_MS - CLOCK_SLACK_MS),
          },
        });
        const liveWindow = await prisma.rateLimitWindow.create({
          data: { subscriberId: subscriber.id, occurredAt: new Date(now) },
        });

        const cronJob = registry.getCronJob(RETENTION_CRON_NAME);
        // The scheduler mounts the job without waitForCompletion, and cron's
        // fireOnTick awaits its callbacks only under it — without this line the
        // awaited fire would resolve before the sweep had run.
        cronJob.waitForCompletion = true;

        const logSpy = jest.spyOn(Logger.prototype, 'log');
        await cronJob.fireOnTick();

        // Exact count, not the sibling's pattern: no other suite seeds rows
        // past the cutoff, and this file's live-database describe seeds its
        // expired rows only in a beforeAll that runs after this test (jest
        // runs describes in declaration order), so the sweep counts the rows seeded here.
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(
          `retention: deleted ${expiredRecordIds.length} records older than ${RETENTION_DAYS}d`,
        );

        for (const expiredId of [...expiredRecordIds, replayOfExpired.id]) {
          expect(await prisma.webhookRecord.findUnique({ where: { id: expiredId } })).toBeNull();
        }

        const survivorIds = (
          await prisma.webhookRecord.findMany({ where: { subscriberId: subscriber.id } })
        )
          .map((record) => record.id)
          .sort((a, b) => a - b);
        const expectedSurvivorIds = [young.id, withinEdge.id, replayOfYoung.id].sort(
          (a, b) => a - b,
        );
        expect(survivorIds).toEqual(expectedSurvivorIds);

        const survivingWindows = await prisma.rateLimitWindow.findMany({
          where: { subscriberId: subscriber.id },
        });
        expect(survivingWindows.map((window) => window.id)).toEqual([liveWindow.id]);
      } finally {
        jest.restoreAllMocks();
        if (workspaceId !== undefined) {
          await prisma.workspace.deleteMany({ where: { id: workspaceId } });
        }
        if (userId !== undefined) {
          await prisma.user.deleteMany({ where: { id: userId } });
        }
      }
    });
  });

  describe('purgeExpiredRecords on a live database', () => {
    // Real PG, not a mock: the replay cascade is a schema FK — a mocked Prisma
    // would only prove the mock. CI deploys migrations before jest (ci.yml).
    // Slack keeps the purge's own Date.now() from flipping a boundary row's
    // fate even if the test stalls between seeding and the call.
    const CLOCK_SLACK_MS = 60_000;

    let moduleRef: TestingModule;
    let prisma: PrismaService;
    let service: RetentionService;
    // A failed seed must skip its own cleanup filter — deleteMany({ where: {} })
    // would wipe every row in the shared test database.
    let workspaceId: number | undefined;
    let userId: number | undefined;
    let subscriberId: number;
    let purgeTargetIds: {
      records: number[];
      keptRecords: number[];
      liveWindow: number;
    };

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        providers: [RetentionService, PrismaService],
      }).compile();
      await moduleRef.init();
      service = moduleRef.get(RetentionService);
      prisma = moduleRef.get(PrismaService);

      const now = Date.now();
      // No global ">7d sweep" here on purpose: it would delete other suites'
      // fixtures (jest runs spec files in parallel against one database), and
      // it is not needed — the assertions below are scoped to this test's
      // subscriberId, and the logged count is matched as a pattern, so leftovers
      // from an aborted earlier run cannot flip the result either.

      const user = await prisma.user.create({
        data: { email: `retention-spec-${now}@example.test`, passwordHash: 'spec-only-hash' },
      });
      userId = user.id;
      const workspace = await prisma.workspace.create({ data: { name: 'retention-spec' } });
      workspaceId = workspace.id;
      const subscriber = await prisma.subscriber.create({
        data: {
          workspaceId: workspace.id,
          name: 'retention-spec',
          ingestToken: `retention-spec-${now}`,
          hmacSecret: 'spec-only-secret',
          destinationUrl: 'https://example.com/hook',
        },
      });
      subscriberId = subscriber.id;

      const seedRow = {
        subscriberId,
        method: 'POST',
        url: 'https://example.com/hook',
        headers: {},
        rawBody: '{}',
        status: RecordStatus.VERIFIED,
        bodyBytes: 2,
      };

      const beyondCutoff = await prisma.webhookRecord.create({
        data: { ...seedRow, receivedAt: new Date(now - (RETENTION_DAYS + 1) * MS_PER_DAY) },
      });
      const deepPast = await prisma.webhookRecord.create({
        data: { ...seedRow, receivedAt: new Date(now - (RETENTION_DAYS + 2) * MS_PER_DAY) },
      });
      const young = await prisma.webhookRecord.create({
        data: { ...seedRow, receivedAt: new Date(now - MS_PER_DAY) },
      });
      const pastEdge = await prisma.webhookRecord.create({
        data: {
          ...seedRow,
          receivedAt: new Date(now - RETENTION_DAYS * MS_PER_DAY - CLOCK_SLACK_MS),
        },
      });
      const withinEdge = await prisma.webhookRecord.create({
        data: {
          ...seedRow,
          receivedAt: new Date(now - RETENTION_DAYS * MS_PER_DAY + CLOCK_SLACK_MS),
        },
      });

      // Replay rows younger than the cutoff: only the FK cascade can remove them.
      const replayOfExpired = await prisma.webhookRecord.create({
        data: { ...seedRow, replayOfId: beyondCutoff.id, receivedAt: new Date(now) },
      });
      const replayOfYoung = await prisma.webhookRecord.create({
        data: { ...seedRow, replayOfId: young.id, receivedAt: new Date(now) },
      });

      await prisma.rateLimitWindow.create({
        data: {
          subscriberId,
          occurredAt: new Date(now - RATE_LIMIT_WINDOW_MS - CLOCK_SLACK_MS),
        },
      });
      const liveWindow = await prisma.rateLimitWindow.create({
        data: { subscriberId, occurredAt: new Date(now) },
      });

      purgeTargetIds = {
        records: [beyondCutoff.id, deepPast.id, pastEdge.id, replayOfExpired.id],
        keptRecords: [young.id, withinEdge.id, replayOfYoung.id],
        liveWindow: liveWindow.id,
      };
    });

    afterAll(async () => {
      if (prisma) {
        if (workspaceId !== undefined) {
          await prisma.workspace.deleteMany({ where: { id: workspaceId } }); // cascades subscriber → its records + window rows
        }
        if (userId !== undefined) {
          await prisma.user.deleteMany({ where: { id: userId } });
        }
        await moduleRef.close();
      }
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('deletes only rows older than 7d, cascades their replays, prunes stale window rows, logs the count', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');

      await service.purgeExpiredRecords();

      expect(logSpy).toHaveBeenCalledTimes(1);
      // Pattern, not an exact number: a concurrent suite seeding >7d rows would
      // change the total, and this suite must not depend on what else shares
      // the database. The exact deletion set is pinned by the row checks below.
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^retention: deleted \\d+ records older than ${RETENTION_DAYS}d$`),
        ),
      );

      const survivorIds = (
        await prisma.webhookRecord.findMany({ where: { subscriberId } })
      )
        .map((record) => record.id)
        .sort((a, b) => a - b);
      expect(survivorIds).toEqual([...purgeTargetIds.keptRecords].sort((a, b) => a - b));

      for (const expiredId of purgeTargetIds.records) {
        expect(await prisma.webhookRecord.findUnique({ where: { id: expiredId } })).toBeNull();
      }

      const survivingWindows = await prisma.rateLimitWindow.findMany({
        where: { subscriberId },
      });
      expect(survivingWindows.map((window) => window.id)).toEqual([
        purgeTargetIds.liveWindow,
      ]);
    });
  });
});
