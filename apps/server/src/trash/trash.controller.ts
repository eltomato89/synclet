import { Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { RestoreResult, TrashEntryWire } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../common/types';
import { TrashService } from './trash.service';

@Controller('trash')
@UseGuards(AuthGuard)
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<TrashEntryWire[]> {
    return this.trash.list(user);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RestoreResult> {
    return this.trash.restore(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteForever(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.trash.deleteForever(user, id);
  }

  @Delete()
  async empty(@CurrentUser() user: AuthUser): Promise<{ removed: number }> {
    return { removed: await this.trash.empty(user) };
  }
}
