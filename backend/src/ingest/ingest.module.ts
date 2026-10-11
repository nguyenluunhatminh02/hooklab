import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { RateLimitService } from './rate-limit.service';

// PrismaModule is @Global — its PrismaService needs no import here.
@Module({
  controllers: [IngestController],
  providers: [IngestService, RateLimitService],
})
export class IngestModule {}
