import { Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SpaceAccess, type Role } from '../spaces/space-access.service';
import { apiSpaceId, spaceIdFromApi } from '../spaces/space-ids';
import type { ItemView } from './serializer.service';
import { parseRootId, parseSyncId, ROOT_ID } from './sync-ids';

/** A sync id resolved for a caller: its space, the caller's role there, and the live row (null = the space root). */
export interface Resolved {
  space: IndexSpace;
  role: Role;
  item: Item | null;
  view: ItemView;
}

/**
 * Resolves sync ids (`root`, `r_<uuid>`, `d_…`, `f_…`) across all spaces and checks the caller's
 * access through SpaceAccess.require: no access → 404 (indistinguishable from a missing item),
 * write needed but read only → 403, space missing → 503 `space_unavailable`.
 */
@Injectable()
export class ItemResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SpaceAccess,
  ) {}

  async resolve(user: { id: string }, rawId: string | undefined | null, need: Role): Promise<Resolved> {
    const id = (rawId ?? '').trim();
    if (id === ROOT_ID) return { ...(await this.require(user, user.id, need)), item: null };
    const rootSpace = parseRootId(id);
    if (rootSpace) {
      const r = await this.require(user, rootSpace, need);
      // The personal root has exactly one id, `root`: `r_<user id>` does not exist.
      if (r.space.kind === 'personal') throw new SyncError('not_found');
      return { ...r, item: null };
    }
    const parsed = parseSyncId(id);
    if (!parsed || parsed.kind === 'root') throw new SyncError('invalid_request', 'invalid id');
    const row = await this.prisma.item.findFirst({ where: { id: parsed.uuid, deletedAt: null, type: parsed.kind } });
    if (!row) throw new SyncError('not_found');
    return { ...(await this.require(user, row.spaceId, need)), item: row };
  }

  /** Like resolve(), for a space given by its API id (`personal` or uuid); malformed → 404. */
  async space(user: { id: string }, apiId: string, need: Role): Promise<Omit<Resolved, 'item'>> {
    const spaceId = spaceIdFromApi(user, apiId);
    if (!spaceId) throw new SyncError('not_found');
    return this.require(user, spaceId, need);
  }

  private async require(user: { id: string }, spaceId: string, need: Role): Promise<Omit<Resolved, 'item'>> {
    try {
      const { space, role } = await this.access.require(user, spaceId, need);
      return { space, role, view: { apiSpaceId: apiSpaceId(space, user), role } };
    } catch (e) {
      // Same body as a missing item: the existence of an item in a foreign space is never revealed.
      if (e instanceof SyncError && e.code === 'not_found') throw new SyncError('not_found');
      throw e;
    }
  }
}
