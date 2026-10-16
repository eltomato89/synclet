import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { RestoreResult, TrashEntryWire } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { SpaceAccess } from '../spaces/space-access.service';
import { apiSpaceId, PERSONAL_API_ID } from '../spaces/space-ids';
import { SpacesRepo } from '../spaces/spaces.repo';
import { ItemResolver, type Resolved } from '../sync/item-resolver';
import { TrashService } from './trash.service';

/**
 * The trash of every space the caller can write: listing shows them all (with `spaceId` and
 * `deletedBy`); restore and delete forever need write in the entry's space (read only → 403, no
 * access → 404); emptying empties the personal space unless `?space=` names another.
 */
@Controller('trash')
@UseGuards(AuthGuard)
export class TrashController {
  constructor(
    private readonly trash: TrashService,
    private readonly access: SpaceAccess,
    private readonly spaces: SpacesRepo,
    private readonly resolver: ItemResolver,
  ) {}

  /** The entry's space with write access; an unknown entry and a foreign space are both 404. */
  private async entrySpace(user: AuthUser, id: string): Promise<Omit<Resolved, 'item'>> {
    const spaceId = await this.trash.spaceOf(id);
    if (!spaceId) throw new SyncError('not_found');
    return this.resolver.space(user, spaceId, 'write');
  }

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<TrashEntryWire[]> {
    const spaces = (await this.access.spacesFor(user))
      .filter(({ space, role }) => role === 'write' && space.status === 'available')
      .map(({ space }) => ({ space: this.spaces.toIndexSpace(space), apiSpaceId: apiSpaceId(space, user) }));
    return this.trash.list(spaces);
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RestoreResult> {
    const { space, view } = await this.entrySpace(user, id);
    return this.trash.restore(space, id, view);
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteForever(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    const { space } = await this.entrySpace(user, id);
    await this.trash.deleteForever(space, id);
  }

  @Delete()
  async empty(@CurrentUser() user: AuthUser, @Query('space') space?: string): Promise<{ removed: number }> {
    const target = typeof space === 'string' && space !== '' ? space : PERSONAL_API_ID;
    const { space: s } = await this.resolver.space(user, target, 'write');
    return { removed: await this.trash.empty(s) };
  }
}
