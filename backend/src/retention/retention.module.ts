import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

// No routes: the provider exists so its @Cron handler is discovered exactly
// once by ScheduleModule (forRoot'd in AppModule, C7) — a second registration
// point would run the daily sweep twice.
@Module({
  providers: [RetentionService],
})
export class RetentionModule {}
