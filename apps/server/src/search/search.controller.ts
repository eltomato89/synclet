import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SearchResponse, SyncItem } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesRepo } from '../spaces/spaces.repo';
import { SerializerService } from '../sync/serializer.service';
import { SearchService } from './search.service';

const clamp = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && raw !== undefined && raw !== '' ? Math.min(Math.max(n, min), max) : def;
};

@Controller('sync/v1')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly serializer: SerializerService,
    private readonly spaces: SpacesRepo,
  ) {}

  @Get('search')
  async find(
    @CurrentUser() user: AuthUser,
    @Query('q') q: string | undefined,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('folder') folder?: string,
  ): Promise<SearchResponse> {
    return this.search.search(await this.spaces.personalFor(user.id), typeof q === 'string' ? q : '', {
      limit: clamp(limit, 20, 1, 50),
      offset: clamp(offset, 0, 0, 10_000),
      folderId: typeof folder === 'string' && folder !== '' ? folder : undefined,
    });
  }

  /** The caller's live files, most recently modified first (served by `Item_space_mtime_idx`). */
  @Get('recent')
  async recent(@CurrentUser() user: AuthUser, @Query('limit') limit?: string): Promise<SyncItem[]> {
    const space = await this.spaces.personalFor(user.id);
    const rows = await this.prisma.$queryRaw<Item[]>`
      SELECT * FROM "Item"
      WHERE "spaceId" = ${space.id}::uuid AND "deletedAt" IS NULL AND type = 'file'
      ORDER BY mtime DESC, id
      LIMIT ${clamp(limit, 50, 1, 200)}`;
    return this.serializer.toSyncItems(space, rows);
  }
}
