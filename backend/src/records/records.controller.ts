import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ListRecordsQueryDto } from './dto/list-records.query.dto';
import { RecordDetail } from './records.mapper';
import { RecordListResponse, SubscriberStats } from './records.repository';
import { RecordsService } from './records.service';

@Controller('api')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get('subscribers/:subscriberId/records')
  listForSubscriber(
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
    @Query() query: ListRecordsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RecordListResponse> {
    return this.records.listForSubscriber(subscriberId, user.userId, query);
  }

  @Get('workspaces/:workspaceId/records')
  listForWorkspace(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Query() query: ListRecordsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RecordListResponse> {
    return this.records.listForWorkspace(workspaceId, user.userId, query);
  }

  @Get('records/:recordId')
  async detail(
    @Param('recordId', ParseIntPipe) recordId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ data: RecordDetail }> {
    return { data: await this.records.detail(recordId, user.userId) };
  }

  @Get('subscribers/:subscriberId/stats')
  async stats(
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ data: SubscriberStats }> {
    return { data: await this.records.stats(subscriberId, user.userId) };
  }
}
