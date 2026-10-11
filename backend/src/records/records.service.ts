import { Injectable, NotFoundException } from '@nestjs/common';
import { RecordStatus } from '../generated/prisma/client';
import { MembershipService } from '../common/membership/membership.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ListRecordsQueryDto } from './dto/list-records.query.dto';
import { RecordDetail, toRecordDetail } from './records.mapper';
import { ListRecordsOptions, RecordListResponse, RecordsRepository, SubscriberStats } from './records.repository';

const WIRE_STATUS_TO_PRISMA: Record<'verified' | 'rejected', RecordStatus> = {
  verified: RecordStatus.VERIFIED,
  rejected: RecordStatus.REJECTED,
};

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RecordsRepository,
    private readonly membership: MembershipService,
  ) {}

  async listForSubscriber(
    subscriberId: number,
    userId: number,
    query: ListRecordsQueryDto,
  ): Promise<RecordListResponse> {
    await this.assertSubscriberMember(subscriberId, userId);
    return this.repository.listForSubscriber(subscriberId, this.toOptions(query));
  }

  async listForWorkspace(
    workspaceId: number,
    userId: number,
    query: ListRecordsQueryDto,
  ): Promise<RecordListResponse> {
    await this.membership.assertMember(workspaceId, userId);
    return this.repository.listForWorkspace(workspaceId, this.toOptions(query));
  }

  async detail(recordId: number, userId: number): Promise<RecordDetail> {
    const record = await this.prisma.webhookRecord.findUnique({
      where: { id: recordId },
      include: {
        subscriber: {
          select: {
            workspaceId: true,
            name: true,
            destinationMethod: true,
            destinationUrl: true,
            destinationHeaders: true,
          },
        },
        replays: { orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (record === null) throw new NotFoundException({ message: 'record not found' });
    await this.membership.assertMember(record.subscriber.workspaceId, userId);
    return toRecordDetail(record);
  }

  async stats(subscriberId: number, userId: number): Promise<SubscriberStats> {
    await this.assertSubscriberMember(subscriberId, userId);
    return this.repository.stats(subscriberId);
  }

  private async assertSubscriberMember(subscriberId: number, userId: number): Promise<void> {
    const subscriber = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { workspaceId: true },
    });
    if (subscriber === null) throw new NotFoundException({ message: 'subscriber not found' });
    await this.membership.assertMember(subscriber.workspaceId, userId);
  }

  private toOptions(query: ListRecordsQueryDto): ListRecordsOptions {
    return {
      status: query.status === undefined ? undefined : WIRE_STATUS_TO_PRISMA[query.status],
      q: query.q,
      limit: query.limit,
      cursor: query.cursor,
      offset: query.offset,
      includeReplays: query.includeReplays === true,
    };
  }
}
