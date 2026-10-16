import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SearchResponse, SyncItem } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SpaceAccess } from '../spaces/space-access.service';
import { apiSpaceId } from '../spaces/space-ids';
import { SpacesRepo } from '../spaces/spaces.repo';
import { ItemResolver } from '../sync/item-resolver';
import { SearchService, type SearchSpace } from './search.service';

const clamp = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && raw !== undefined && raw !== '' ? Math.min(Math.max(n, min), max) : def;
};

const given = (raw: unknown): string | undefined => (typeof raw === 'string' && raw !== '' ? raw : undefined);

@Controller('sync/v1')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly access: SpaceAccess,
    private readonly spaces: SpacesRepo,
    private readonly resolver: ItemResolver,
  ) {}

  /**
   * The spaces a search or recent list covers: `space=<apiId>` (readable, else 404; missing → 503),
   * else every readable space that is available (a missing one is skipped, not an error).
   */
  private async scope(user: AuthUser, space: string | undefined): Promise<SearchSpace[]> {
    if (space !== undefined) {
      const r = await this.resolver.space(user, space, 'read');
      return [{ space: r.space, view: r.view }];
    }
    return (await this.access.spacesFor(user))
      .filter(({ space: s }) => s.status === 'available')
      .map(({ space: s, role }) => ({ space: this.spaces.toIndexSpace(s), view: { apiSpaceId: apiSpaceId(s, user), role } }));
  }

  @Get('search')
  async find(
    @CurrentUser() user: AuthUser,
    @Query('q') q: string | undefined,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('folder') folder?: string,
    @Query('space') space?: string,
  ): Promise<SearchResponse> {
    const query = typeof q === 'string' ? q : '';
    const spaceId = given(space);
    const folderId = given(folder);
    let spaces: SearchSpace[];
    let folderPath: string | undefined;
    if (folderId !== undefined) {
      // The folder (or a space root) decides the space; it must be readable and lie in `space` if both are given.
      const r = await this.resolver.resolve(user, folderId, 'read');
      if (r.item && r.item.type !== 'folder') throw new SyncError('invalid_request', 'not a folder');
      if (spaceId !== undefined && (await this.resolver.space(user, spaceId, 'read')).space.id !== r.space.id) {
        throw new SyncError('invalid_request', 'folder is not in space');
      }
      spaces = [{ space: r.space, view: r.view }];
      folderPath = r.item?.path;
    } else {
      spaces = await this.scope(user, spaceId);
    }
    return this.search.search(spaces, query, {
      limit: clamp(limit, 20, 1, 50),
      offset: clamp(offset, 0, 0, 10_000),
      folderPath,
    });
  }

  /** Live files across the caller's readable spaces (or `space=`), most recently modified first. */
  @Get('recent')
  async recent(@CurrentUser() user: AuthUser, @Query('limit') limit?: string, @Query('space') space?: string): Promise<SyncItem[]> {
    const spaces = await this.scope(user, given(space));
    if (spaces.length === 0) return [];
    const ids = spaces.map((s) => s.space.id);
    const rows = await this.prisma.$queryRaw<Item[]>`
      SELECT * FROM "Item"
      WHERE "spaceId" = ANY(${ids}::uuid[]) AND "deletedAt" IS NULL AND type = 'file'
      ORDER BY mtime DESC, id
      LIMIT ${clamp(limit, 50, 1, 200)}`;
    return this.search.serializeAcross(spaces, rows);
  }
}
