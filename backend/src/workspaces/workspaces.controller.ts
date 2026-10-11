import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceSummary, WorkspacesService } from './workspaces.service';

@Controller('api/workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<{ data: WorkspaceSummary[] }> {
    return { data: await this.workspaces.list(user.userId) };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<{ data: WorkspaceSummary }> {
    return { data: await this.workspaces.create(user.userId, dto) };
  }

  @Delete(':workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
  ): Promise<void> {
    return this.workspaces.remove(workspaceId, user.userId);
  }
}
