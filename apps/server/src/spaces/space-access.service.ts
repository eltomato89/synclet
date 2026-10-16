import { Injectable } from '@nestjs/common';
import type { Space } from '@prisma/client';
import { UUID } from '../common/ids';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesRepo } from './spaces.repo';

export type Role = 'read' | 'write';
export type SpaceRow = Space;

const KIND_ORDER: Record<Space['kind'], number> = { personal: 0, team: 1, external: 2 };

const maxRole = (roles: Iterable<Role>): Role | null => {
  let best: Role | null = null;
  for (const r of roles) { if (r === 'write') return 'write'; best = 'read'; }
  return best;
};

/**
 * Who may read or write which space (spec §1.2). Admins have no implicit access; disabled users
 * have none at all. Removed (`ignored`) spaces do not exist for anyone. A missing space still yields a role (it is listed); `require` maps it to 503.
 */
@Injectable()
export class SpaceAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesRepo,
  ) {}

  /** Role of `user` in `space` or null (no access). */
  async roleFor(
    user: { id: string },
    space: { id: string; kind: string; userId: string | null; readOnly: boolean },
  ): Promise<Role | null> {
    if (!(await this.enabled(user.id))) return null;
    return this.roleOfEnabled(user.id, space);
  }

  /** All spaces the user can read: personal, then team (by name), then external (by name). */
  async spacesFor(user: { id: string }): Promise<Array<{ space: SpaceRow; role: Role }>> {
    if (!(await this.enabled(user.id))) return [];
    const groupIds = await this.groupIdsOf(user.id);
    const rows = await this.prisma.space.findMany({
      where: {
        OR: [
          { kind: 'personal', userId: user.id },
          { kind: { in: ['team', 'external'] }, status: { not: 'ignored' }, members: { some: { OR: [{ userId: user.id }, { groupId: { in: groupIds } }] } } },
        ],
      },
      include: { members: { where: { OR: [{ userId: user.id }, { groupId: { in: groupIds } }] }, select: { role: true } } },
    });
    const out: Array<{ space: SpaceRow; role: Role }> = [];
    for (const { members, ...space } of rows) {
      const role = space.kind === 'personal' ? 'write' : this.cap(space, maxRole(members.map((m) => m.role)));
      if (role) out.push({ space, role });
    }
    return out.sort((a, b) => KIND_ORDER[a.space.kind] - KIND_ORDER[b.space.kind] || a.space.name.localeCompare(b.space.name));
  }

  /**
   * Access check for an operation on `spaceId` (also accepts the API alias `personal`).
   * No access → 404 not_found; write needed but read only → 403 forbidden; space missing → 503.
   */
  async require(user: { id: string }, spaceId: string, need: Role): Promise<{ space: IndexSpace; role: Role }> {
    const id = spaceId === 'personal' ? user.id : spaceId;
    const row = UUID.test(id) ? await this.prisma.space.findUnique({ where: { id } }) : null;
    const role = row && row.status !== 'ignored' ? await this.roleFor(user, row) : null;
    if (!row || !role) throw new SyncError('not_found', 'space not found');
    if (row.status === 'missing') throw new SyncError('space_unavailable', 'space is unavailable (storage not mounted)');
    if (need === 'write' && role !== 'write') throw new SyncError('forbidden', 'read-only access to this space');
    return { space: this.spaces.toIndexSpace(row), role };
  }

  /** User ids affected by a membership/space change (for SSE `account`). */
  async usersOf(spaceId: string): Promise<string[]> {
    if (!UUID.test(spaceId)) return [];
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { kind: true, status: true, userId: true, members: { select: { userId: true, group: { select: { members: { select: { userId: true } } } } } } },
    });
    if (!space || space.status === 'ignored') return [];
    if (space.kind === 'personal') return space.userId ? [space.userId] : [];
    const ids = new Set<string>();
    for (const m of space.members) {
      if (m.userId) ids.add(m.userId);
      for (const gm of m.group?.members ?? []) ids.add(gm.userId);
    }
    return [...ids];
  }

  private async enabled(userId: string): Promise<boolean> {
    if (!UUID.test(userId)) return false;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { disabledAt: true } });
    return !!u && u.disabledAt === null;
  }

  private groupIdsOf(userId: string): Promise<string[]> {
    return this.prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } }).then((r) => r.map((g) => g.groupId));
  }

  private async roleOfEnabled(userId: string, space: { id: string; kind: string; userId: string | null; readOnly: boolean }): Promise<Role | null> {
    if (space.kind === 'personal') return space.userId === userId ? 'write' : null;
    // Removed (ignored) spaces count as non-existent.
    const members = await this.prisma.spaceMember.findMany({
      where: { spaceId: space.id, space: { status: { not: 'ignored' } }, OR: [{ userId }, { group: { members: { some: { userId } } } }] },
      select: { role: true },
    });
    return this.cap(space, maxRole(members.map((m) => m.role)));
  }

  private cap(space: { readOnly: boolean }, role: Role | null): Role | null {
    return role && space.readOnly ? 'read' : role;
  }
}
