import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AdminGroupWire } from '@synclet/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly } from '../auth/current-user.decorator';
import { UUID } from '../common/ids';
import { nameKey } from '../common/names';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { AccountSignal } from '../spaces/account-signal';

type Tx = Prisma.TransactionClient;

const GroupName = z.string().trim().min(1).max(100);
const MemberIds = z.array(z.string().regex(UUID, 'invalid user id')).max(10_000);
const CreateBody = z.object({ name: GroupName, memberIds: MemberIds.optional() });
const PatchBody = z.object({ name: GroupName.optional(), memberIds: MemberIds.optional() });

const nameTaken = () => new SyncError('name_conflict', 'a group with this name exists');

/**
 * Groups (spec §3.5): a group grants its members the roles it has in spaces. Membership changes
 * signal `account` to the users who gain or lose spaces through the group (before ∪ after).
 */
@Controller('admin/groups')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminGroupsController {
  constructor(private readonly prisma: PrismaService, private readonly signal: AccountSignal) {}

  @Get()
  list(): Promise<AdminGroupWire[]> {
    return this.wires();
  }

  @Post()
  @HttpCode(201)
  async create(@Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<AdminGroupWire> {
    const id = await this.write(async (tx) => {
      await this.assertNameFree(tx, body.name, null);
      const g = await tx.group.create({ data: { name: body.name.normalize('NFC'), nameKey: nameKey(body.name) } });
      if (body.memberIds?.length) await this.setMembers(tx, g.id, body.memberIds);
      return g.id;
    });
    // A new group has no spaces yet: nobody's space list changes.
    return (await this.wires(id))[0];
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>): Promise<AdminGroupWire> {
    if (!UUID.test(id)) throw new SyncError('not_found', 'group not found');
    const affected = await this.write(async (tx) => {
      const group = await tx.group.findUnique({ where: { id } });
      if (!group) throw new SyncError('not_found', 'group not found');
      if (body.name !== undefined) {
        await this.assertNameFree(tx, body.name, id);
        await tx.group.update({ where: { id }, data: { name: body.name.normalize('NFC'), nameKey: nameKey(body.name) } });
      }
      if (body.memberIds === undefined) return [];
      const before = await this.memberIds(tx, id);
      await this.setMembers(tx, id, body.memberIds);
      return (await this.hasSpaces(tx, id)) ? [...before, ...body.memberIds] : [];
    });
    await this.signal.notify(affected);
    return (await this.wires(id))[0];
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!UUID.test(id)) throw new SyncError('not_found', 'group not found');
    const affected = await this.write(async (tx) => {
      const group = await tx.group.findUnique({ where: { id } });
      if (!group) throw new SyncError('not_found', 'group not found');
      const members = (await this.hasSpaces(tx, id)) ? await this.memberIds(tx, id) : [];
      await tx.group.delete({ where: { id } }); // cascades to GroupMember and SpaceMember
      return members;
    });
    await this.signal.notify(affected);
  }

  private async wires(id?: string): Promise<AdminGroupWire[]> {
    const rows = await this.prisma.group.findMany({
      where: id ? { id } : undefined,
      include: { members: { include: { user: { select: { id: true, username: true, displayName: true } } } } },
    });
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
    return rows
      .map((g) => ({
        id: g.id, name: g.name,
        members: g.members.map((m) => m.user).sort((a, b) => byName(a.displayName, b.displayName) || byName(a.username, b.username)),
      }))
      .sort((a, b) => byName(a.name, b.name));
  }

  /** A transaction; a racing insert of the same name key surfaces as 409, not 500. */
  private async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, TX_OPTS);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw nameTaken();
      throw e;
    }
  }

  private async assertNameFree(tx: Tx, name: string, self: string | null): Promise<void> {
    const other = await tx.group.findUnique({ where: { nameKey: nameKey(name) }, select: { id: true } });
    if (other && other.id !== self) throw nameTaken();
  }

  /** Replaces the members; every id must be an existing user. */
  private async setMembers(tx: Tx, groupId: string, userIds: string[]): Promise<void> {
    const ids = [...new Set(userIds)];
    const found = await tx.user.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new SyncError('invalid_request', 'unknown user in memberIds');
    await tx.groupMember.deleteMany({ where: { groupId } });
    if (ids.length) await tx.groupMember.createMany({ data: ids.map((userId) => ({ groupId, userId })) });
  }

  private memberIds(tx: Tx, groupId: string): Promise<string[]> {
    return tx.groupMember.findMany({ where: { groupId }, select: { userId: true } }).then((r) => r.map((m) => m.userId));
  }

  /** Whether the group grants access to any (non-removed) space, i.e. its members' space lists depend on it. */
  private async hasSpaces(tx: Tx, groupId: string): Promise<boolean> {
    return !!(await tx.spaceMember.findFirst({ where: { groupId, space: { status: { not: 'ignored' } } }, select: { id: true } }));
  }
}
