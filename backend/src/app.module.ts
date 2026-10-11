import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { MembershipModule } from './common/membership/membership.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SubscribersModule } from './subscribers/subscribers.module';
import { RecordsModule } from './records/records.module';
import { ReplayModule } from './replay/replay.module';
import { IngestModule } from './ingest/ingest.module';
import { RetentionModule } from './retention/retention.module';
import { REQUEST_ID_PATTERN } from './common/constants/app.constants';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // S-1: never log credentials that ride along on every request.
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.headers["x-hub-signature"]',
          'req.headers["x-hub-signature-256"]',
          'req.headers["x-custom-secret"]',
          'req.headers["x-signature"]',
          'req.headers["webhook-signature"]',
          'req.headers["x-github-signature"]',
          'req.headers["x-github-signature-256"]',
          'req.headers["stripe-signature"]',
        ],
        genReqId: (req) => {
          const header = req.headers['x-request-id'];
          const fromHeader = Array.isArray(header) ? header[0] : header;
          // L-4: a client-supplied id is attacker-controlled input echoed into
          // logs and error envelopes — accept only a conservative charset/length.
          return typeof fromHeader === 'string' && REQUEST_ID_PATTERN.test(fromHeader)
            ? fromHeader
            : `req_${randomUUID()}`;
        },
      },
    }),
    ScheduleModule.forRoot(), // exactly once (C7)
    PrismaModule,
    MembershipModule, // @Global — must be registered once at the root
    HealthModule,
    AuthModule,
    WorkspacesModule,
    SubscribersModule,
    RecordsModule,
    ReplayModule,
    IngestModule,
    RetentionModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter }, // THE one filter (C21)
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // @Public() opt-out
  ],
})
export class AppModule {}
