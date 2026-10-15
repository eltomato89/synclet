import { Controller, Get, UseGuards } from '@nestjs/common';
import type { AdminStatusWire } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly } from '../auth/current-user.decorator';
import { AdminStatusService } from './admin-status.service';

@Controller('admin/status')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminStatusController {
  constructor(private readonly status: AdminStatusService) {}

  @Get()
  get(): Promise<AdminStatusWire> {
    return this.status.get();
  }
}
