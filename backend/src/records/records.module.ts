import { Module } from '@nestjs/common';
import { RecordsController } from './records.controller';
import { RecordsRepository } from './records.repository';
import { RecordsService } from './records.service';

@Module({
  controllers: [RecordsController],
  providers: [RecordsService, RecordsRepository],
})
export class RecordsModule {}
