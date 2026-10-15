import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { AdminUserWire, UnassignedFolder } from '@synclet/shared';
import type { Prisma, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly, CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../auth/users.service';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { UUID } from '../sync/sync-ids';

const CreateBody = z.object({
  username: z.string(), displayName: z.string().min(1).max(100), email: z.string().email().nullish(),
  password: z.string().min(10).max(200), role: z.enum(['admin', 'user']).default('user'),
  adoptExistingFolder: z.boolean().optional(),
});
const PatchBody = z.object({
  displayName: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(['admin', 'user']).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
});

const lastAdmin = () => new SyncError('conflict', 'last admin', undefined, 409);

@Controller('admin')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminUsersController {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService) {}

  private async wires(where?: { id: string }): Promise<AdminUserWire[]> {
    const rows = await this.prisma.user.findMany({ where, orderBy: { createdAt: 'asc' }, include: { identities: true } });
    const ids = rows.map((r) => r.id);
    const sizes = await this.prisma.item.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, type: 'file', deletedAt: null }, _sum: { size: true } });
    const devices = await this.prisma.syncDevice.groupBy({ by: ['userId'], where: { userId: { in: ids }, revokedAt: null }, _count: { _all: true } });
    const used = new Map(sizes.map((s) => [s.ownerId, Number(s._sum.size ?? 0n)]));
    const dev = new Map(devices.map((d) => [d.userId, d._count._all]));
    return rows.map((u) => ({
      ...this.users.toPublic(u), disabled: u.disabledAt !== null, createdAt: u.createdAt.toISOString(), lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      identities: u.identities.map((i) => ({ provider: i.provider, subject: i.subject })), usedBytes: used.get(u.id) ?? 0, devices: dev.get(u.id) ?? 0,
    }));
  }

  @Get('users')
  list(): Promise<AdminUserWire[]> {
    return this.wires();
  }

  @Get('folders/unassigned')
  unassigned(): Promise<UnassignedFolder[]> {
    return this.users.unassignedFolders();
  }

  @Post('users')
  @HttpCode(201)
  async create(@Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<AdminUserWire> {
    const user = await this.users.create(body);
    return (await this.wires({ id: user.id }))[0];
  }

  /** Fails if `user` stopping to be an enabled admin would leave no enabled admin with a local password. */
  private async assertNotLastAdmin(tx: Prisma.TransactionClient, user: User): Promise<void> {
    if (!(await this.users.canRemoveAdmin(tx, user.id))) throw lastAdmin();
  }

  @Patch('users/:id')
  async patch(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>): Promise<AdminUserWire> {
    if (!UUID.test(id)) throw new SyncError('not_found');
    const passwordHash = body.password ? await argon2.hash(body.password, { type: argon2.argon2id }) : null;
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new SyncError('not_found');
      const disabling = body.disabled === true && !user.disabledAt;
      if (disabling && id === me.id) throw new SyncError('conflict', 'cannot disable yourself', undefined, 409);
      if (disabling || body.role === 'user') await this.assertNotLastAdmin(tx, user);
      if (body.email) {
        const email = body.email.toLowerCase();
        if (await tx.user.findFirst({ where: { email, NOT: { id } } })) throw new SyncError('name_conflict', 'email already in use');
      }
      await tx.user.update({
        where: { id },
        data: {
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.email !== undefined ? { email: body.email?.toLowerCase() ?? null } : {}),
          ...(body.role ? { role: body.role } : {}),
          ...(body.disabled !== undefined ? { disabledAt: body.disabled ? (user.disabledAt ?? new Date()) : null } : {}),
        },
      });
      if (passwordHash) await this.users.setLocalPassword(tx, user, passwordHash);
      if (disabling || passwordHash) await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'admin' } });
    }, TX_OPTS);
    return (await this.wires({ id }))[0];
  }

  /** Disables the user and revokes sessions, devices and share links. The folder in /data is never touched. */
  @Delete('users/:id')
  @HttpCode(204)
  async remove(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<void> {
    if (!UUID.test(id)) throw new SyncError('not_found');
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new SyncError('not_found');
      if (id === me.id) throw new SyncError('conflict', 'cannot delete yourself', undefined, 409);
      await this.assertNotLastAdmin(tx, user);
      const now = new Date();
      await tx.user.update({ where: { id }, data: { disabledAt: user.disabledAt ?? now } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'admin' } });
      await tx.syncDevice.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.shareLink.updateMany({ where: { ownerId: id, revokedAt: null }, data: { revokedAt: now } });
    }, TX_OPTS);
  }
}
