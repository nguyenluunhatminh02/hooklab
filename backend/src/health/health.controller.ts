import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/guards/public.decorator';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process is up (C19). */
  @Public()
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: database reachable via `SELECT 1` (C19). 503 when not. */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('database not ready');
    }
  }
}
