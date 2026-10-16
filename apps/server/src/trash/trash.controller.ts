import { Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { RestoreResult, TrashEntryWire } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../common/types';
import { SpacesRepo } from '../spaces/spaces.repo';
import { TrashService } from './trash.service';

@Controller('trash')
@UseGuards(AuthGuard)
export class TrashController {
  constructor(private readonly trash: TrashService, private readonly spaces: SpacesRepo) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<TrashEntryWire[]> {
    return this.trash.list(await this.spaces.personalFor(user.id));
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RestoreResult> {
    return this.trash.restore(await this.spaces.personalFor(user.id), id);
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteForever(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.trash.deleteForever(await this.spaces.personalFor(user.id), id);
  }

  @Delete()
  async empty(@CurrentUser() user: AuthUser): Promise<{ removed: number }> {
    return { removed: await this.trash.empty(await this.spaces.personalFor(user.id)) };
  }
}
