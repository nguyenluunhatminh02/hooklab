import { Body, Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ReplayDto } from './dto/replay.dto';
import { ReplayService, ReplaySuccess } from './replay.service';

@Controller('api/records')
export class ReplayController {
  constructor(private readonly replayService: ReplayService) {}

  @Post(':recordId/replay')
  // 02 §6 C4: replay answers 200 on success — POST's NestJS default of 201 is wrong here.
  @HttpCode(HttpStatus.OK)
  replay(
    @Param('recordId', ParseIntPipe) recordId: number,
    @Body() dto: ReplayDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplaySuccess> {
    return this.replayService.replay(recordId, user.userId, dto);
  }
}
