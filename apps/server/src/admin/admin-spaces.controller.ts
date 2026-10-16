import { Body, Controller, Delete, Get, HttpCode, Logger, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Prisma, Space } from '@prisma/client';
import type { AdminSpaceMemberInput, AdminSpaceMemberWire, AdminSpaceWire } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly } from '../auth/current-user.decorator';
import { AppEvents } from '../common/events';
import { UUID } from '../common/ids';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { IndexerService } from '../indexer/indexer.service';
import { JournalService } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { AccountSignal } from '../spaces/account-signal';
import { DiscoveryService } from '../spaces/discovery.service';
import { SpaceAccess } from '../spaces/space-access.service';
import { SpacesRepo } from '../spaces/spaces.repo';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** Per-space scan interval bounds: the scheduler never cycles faster than 10 s, the web UI has the same minimum. */
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 365 * 24 * 3600;

const Member = z.object({ kind: z.enum(['user', 'group']), id: z.string().regex(UUID, 'invalid id'), role: z.enum(['read', 'write']) });
const Members = z.array(Member).max(10_000);
// Name rules (file name rules, unique in /teams) are checked by DiscoveryService.
const Name = z.string().max(1000);
const CreateBody = z.object({ name: Name, members: Members.optional() });
const PatchBody = z.object({
  name: Name.optional(),
  watch: z.enum(['auto', 'off']).optional(),
  scanIntervalSec: z.number().int().min(MIN_INTERVAL_SEC).max(MAX_INTERVAL_SEC).nullable().optional(),
  members: Members.optional(),
});

const KIND_ORDER: Record<string, number> = { team: 0, external: 1 };
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * Team folders and external storages (spec §3.5). "Remove" only ignores a space (members and index
 * dropped, folder kept); restore takes it back. Every change that can alter someone's space list or
 * rights signals `account` to the affected users (before ∪ after).
 */
@Controller('admin/spaces')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminSpacesController {
  private readonly log = new Logger(AdminSpacesController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: DiscoveryService,
    private readonly access: SpaceAccess,
    private readonly signal: AccountSignal,
    private readonly journal: JournalService,
    private readonly spaces: SpacesRepo,
    private readonly indexer: IndexerService,
    private readonly events: AppEvents,
  ) {}

  @Get()
  list(): Promise<AdminSpaceWire[]> {
    return this.wires();
  }

  /** Creates the team folder with its members in one go: invalid members leave neither folder nor row. */
  @Post()
  @HttpCode(201)
  async create(@Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<AdminSpaceWire> {
    const members = body.members ?? [];
    const row = await this.discovery.createTeam(body.name, (tx, space) => this.setMembers(tx, space.id, members));
    await this.signal.notify(await this.access.usersOf(row.id));
    return this.wire(row.id);
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>): Promise<AdminSpaceWire> {
    const row = await this.row(id);
    if (row.status === 'ignored') throw new SyncError('invalid_request', 'the space was removed; restore it first');
    const renaming = body.name !== undefined && body.name.normalize('NFC') !== row.name;
    if (renaming && row.kind !== 'team') throw new SyncError('invalid_request', 'external storages cannot be renamed');
    // Checked before the rename, so a bad member list changes nothing.
    if (body.members) await this.checkMembers(this.prisma, body.members);
    const before = await this.access.usersOf(id);
    if (renaming) await this.discovery.renameTeam(id, body.name!);
    const settings = body.watch !== undefined || body.scanIntervalSec !== undefined;
    if (settings || body.members) {
      await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, id);
        // Removed concurrently (removeSpace holds the same lock): no members for an ignored space.
        const now = await tx.space.findUnique({ where: { id }, select: { status: true } });
        if (!now) throw new SyncError('not_found', 'space not found');
        if (now.status === 'ignored') throw new SyncError('invalid_request', 'the space was removed; restore it first');
        if (settings) {
          await tx.space.update({
            where: { id },
            data: { ...(body.watch ? { watch: body.watch } : {}), ...(body.scanIntervalSec !== undefined ? { scanIntervalSec: body.scanIntervalSec } : {}) },
          });
        }
        if (body.members) await this.setMembers(tx, id, body.members);
      }, TX_OPTS);
    }
    // The watcher picks up watch changes (renames emit this in DiscoveryService already).
    if (settings) this.events.emit('spaces.changed');
    await this.signal.notify([...before, ...(await this.access.usersOf(id))]);
    return this.wire(id);
  }

  /** Removes a team folder or external storage from Synclet (status `ignored`); the folder stays. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.row(id);
    // Members are gone afterwards: collect them first.
    const before = await this.access.usersOf(id);
    await this.discovery.removeSpace(id);
    await this.signal.notify(before);
  }

  /** Takes a removed space back (available or missing per the disk, no members). */
  @Post(':id/restore')
  @HttpCode(200)
  async restore(@Param('id') id: string): Promise<AdminSpaceWire> {
    await this.row(id);
    await this.discovery.restoreSpace(id);
    await this.signal.notify(await this.access.usersOf(id));
    return this.wire(id);
  }

  /** Starts a full scan of the space now; answers before the scan finishes. */
  @Post(':id/scan')
  @HttpCode(202)
  async scan(@Param('id') id: string): Promise<void> {
    const row = await this.row(id);
    if (row.status === 'ignored') throw new SyncError('invalid_request', 'the space was removed; restore it first');
    if (row.status === 'missing') throw new SyncError('space_unavailable', 'space is unavailable (storage not mounted)');
    const space = this.spaces.toIndexSpace(row);
    void this.indexer.fullScan(space).then(
      (stats) => this.log.log(`scan ${row.kind} ${row.name} (admin): ${stats ? JSON.stringify(stats) : 'refused'}`),
      (e: Error) => this.log.error(`scan ${row.kind} ${row.name} (admin): ${e.message}`),
    );
  }

  /** A team folder or external storage; anything else (personal spaces included) is 404. */
  private async row(id: string): Promise<Space> {
    const row = UUID.test(id) ? await this.prisma.space.findUnique({ where: { id } }) : null;
    if (!row || row.kind === 'personal') throw new SyncError('not_found', 'space not found');
    return row;
  }

  private async wire(id: string): Promise<AdminSpaceWire> {
    const [w] = await this.wires(id);
    if (!w) throw new SyncError('not_found', 'space not found');
    return w;
  }

  /** Team folders, then external storages, each by name; removed (`ignored`) ones included. */
  private async wires(id?: string): Promise<AdminSpaceWire[]> {
    const rows = await this.prisma.space.findMany({
      where: { kind: { in: ['team', 'external'] }, ...(id ? { id } : {}) },
      include: { members: { include: { user: { select: { displayName: true } }, group: { select: { name: true } } } } },
    });
    const ids = rows.map((r) => r.id);
    const sizes = await this.prisma.item.groupBy({ by: ['spaceId'], where: { spaceId: { in: ids }, type: 'file', deletedAt: null }, _sum: { size: true } });
    const counts = await this.prisma.item.groupBy({ by: ['spaceId'], where: { spaceId: { in: ids }, deletedAt: null }, _count: { _all: true } });
    const size = new Map(sizes.map((s) => [s.spaceId, Number(s._sum.size ?? 0n)]));
    const count = new Map(counts.map((c) => [c.spaceId, c._count._all]));
    return rows
      .map((r): AdminSpaceWire => ({
        id: r.id, kind: r.kind as AdminSpaceWire['kind'], name: r.name, rootPath: r.rootPath, status: r.status,
        readOnly: r.readOnly, watch: r.watch, scanIntervalSec: r.scanIntervalSec,
        sizeBytes: size.get(r.id) ?? 0, itemCount: count.get(r.id) ?? 0,
        members: r.members
          .map((m): AdminSpaceMemberWire => (m.userId
            ? { kind: 'user', id: m.userId, name: m.user?.displayName ?? '', role: m.role }
            : { kind: 'group', id: m.groupId!, name: m.group?.name ?? '', role: m.role }))
          .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'user' ? -1 : 1) || byName(a.name, b.name)),
      }))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a.name, b.name));
  }

  /** No duplicate user/group, every user and group exists. */
  private async checkMembers(db: Db, members: AdminSpaceMemberInput[]): Promise<void> {
    const keys = new Set(members.map((m) => `${m.kind}:${m.id}`));
    if (keys.size !== members.length) throw new SyncError('invalid_request', 'a user or group is listed twice in members');
    const userIds = members.filter((m) => m.kind === 'user').map((m) => m.id);
    const groupIds = members.filter((m) => m.kind === 'group').map((m) => m.id);
    if (userIds.length && (await db.user.count({ where: { id: { in: userIds } } })) !== userIds.length) throw new SyncError('invalid_request', 'unknown user in members');
    if (groupIds.length && (await db.group.count({ where: { id: { in: groupIds } } })) !== groupIds.length) throw new SyncError('invalid_request', 'unknown group in members');
  }

  /** Replaces the member list (validated again inside the transaction). */
  private async setMembers(tx: Tx, spaceId: string, members: AdminSpaceMemberInput[]): Promise<void> {
    await this.checkMembers(tx, members);
    await tx.spaceMember.deleteMany({ where: { spaceId } });
    if (members.length) {
      await tx.spaceMember.createMany({
        data: members.map((m) => ({ spaceId, role: m.role, ...(m.kind === 'user' ? { userId: m.id } : { groupId: m.id }) })),
      });
    }
  }
}
