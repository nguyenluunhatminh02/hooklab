import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateSubscriberDto } from './dto/create-subscriber.dto';
import { UpdateSubscriberDto } from './dto/update-subscriber.dto';
import {
  RevokeResult,
  RotateResult,
  SubscriberDetail,
  SubscriberSummary,
  SubscribersService,
} from './subscribers.service';

/**
 * 02 §4: creation/listing nests under the workspace (the workspace id is
 * required to place a new subscriber), item routes stay flat — the row already
 * knows its workspace, and Membership resolves subscriber → workspace → member.
 */
@Controller('api')
export class SubscribersController {
  constructor(private readonly subscribers: SubscribersService) {}

  @Get('workspaces/:workspaceId/subscribers')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
  ): Promise<{ data: SubscriberSummary[] }> {
    return { data: await this.subscribers.list(workspaceId, user.userId) };
  }

  @Post('workspaces/:workspaceId/subscribers')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Body() dto: CreateSubscriberDto,
  ): Promise<{ data: SubscriberDetail & { secret: string } }> {
    return { data: await this.subscribers.create(workspaceId, user.userId, dto) };
  }

  @Get('subscribers/:subscriberId')
  async getDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
  ): Promise<{ data: SubscriberDetail }> {
    return { data: await this.subscribers.getDetail(subscriberId, user.userId) };
  }

  @Patch('subscribers/:subscriberId')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
    @Body() dto: UpdateSubscriberDto,
  ): Promise<{ data: SubscriberDetail }> {
    return { data: await this.subscribers.update(subscriberId, user.userId, dto) };
  }

  @Post('subscribers/:subscriberId/rotate')
  @HttpCode(HttpStatus.OK)
  async rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
  ): Promise<{ data: RotateResult }> {
    return { data: await this.subscribers.rotate(subscriberId, user.userId) };
  }

  @Post('subscribers/:subscriberId/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
  ): Promise<{ data: RevokeResult }> {
    return { data: await this.subscribers.revoke(subscriberId, user.userId) };
  }

  @Delete('subscribers/:subscriberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subscriberId', ParseIntPipe) subscriberId: number,
  ): Promise<void> {
    return this.subscribers.remove(subscriberId, user.userId);
  }
}
