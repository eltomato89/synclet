import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import type { AdminDeviceWire, AdminSessionWire } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly } from '../auth/current-user.decorator';
import { DevicesService } from '../auth/devices.service';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { UUID } from '../sync/sync-ids';

@Controller('admin/users/:id')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminSessionsController {
  constructor(private readonly prisma: PrismaService, private readonly devices: DevicesService) {}

  private async user(id: string): Promise<void> {
    if (!UUID.test(id) || !(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw new SyncError('not_found');
  }

  @Get('sessions')
  async sessions(@Param('id') id: string): Promise<AdminSessionWire[]> {
    await this.user(id);
    const rows = await this.prisma.session.findMany({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    return rows.map((s) => ({ id: s.id, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString() }));
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async revokeSession(@Param('id') id: string, @Param('sessionId') sessionId: string): Promise<void> {
    await this.user(id);
    if (!UUID.test(sessionId)) throw new SyncError('not_found');
    const res = await this.prisma.session.updateMany({ where: { id: sessionId, userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw new SyncError('not_found');
  }

  @Delete('sessions')
  @HttpCode(204)
  async revokeAll(@Param('id') id: string): Promise<void> {
    await this.user(id);
    await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  @Get('devices')
  async deviceList(@Param('id') id: string): Promise<AdminDeviceWire[]> {
    await this.user(id);
    return (await this.devices.list(id)).map((d) => ({ ...this.devices.toWire(d), userId: id }));
  }

  @Delete('devices/:deviceId')
  @HttpCode(204)
  async revokeDevice(@Param('id') id: string, @Param('deviceId') deviceId: string): Promise<void> {
    await this.user(id);
    if (!UUID.test(deviceId)) throw new SyncError('not_found');
    await this.devices.revoke(id, deviceId);
  }
}
