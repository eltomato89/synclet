import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ServerStatus } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulerService } from './scheduler.service';
import { WatcherService } from './watcher.service';

@Controller('admin/status')
@UseGuards(AuthGuard)
@AdminOnly()
export class StatusController {
  constructor(private readonly watcher: WatcherService, private readonly scheduler: SchedulerService, private readonly prisma: PrismaService) {}

  @Get()
  async status(): Promise<ServerStatus> {
    return { watch: this.watcher.mode, lastFullScanAt: this.scheduler.lastFullScanAt?.toISOString() ?? null, users: await this.prisma.user.count({ where: { disabledAt: null } }) };
  }
}
