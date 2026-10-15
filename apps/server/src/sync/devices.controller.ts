import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { DevicesService } from '../auth/devices.service';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { SyncController } from './sync.controller';
import { UUID } from './sync-ids';

const RegisterBody = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(['ios', 'android', 'macos', 'windows', 'linux', 'web']),
  appVersion: z.string().min(1).max(40),
  installationId: z.string().max(128).optional(),
});

@Controller('sync/v1/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService, private readonly sync: SyncController) {}

  @Post()
  @HttpCode(201)
  async register(@CurrentUser() user: AuthUser, @Body(new ZodPipe(RegisterBody)) body: z.infer<typeof RegisterBody>) {
    const { device, token } = await this.devices.register(user, body);
    return { device: this.devices.toWire(device), token, account: await this.sync.account(user) };
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return (await this.devices.list(user.id)).map((d) => this.devices.toWire(d, user.deviceId));
  }

  @Delete('current')
  @HttpCode(204)
  async revokeCurrent(@CurrentUser() user: AuthUser) {
    if (!user.deviceId) throw new SyncError('invalid_request', 'not a device token');
    await this.devices.revoke(user.id, user.deviceId);
  }

  @Put('current/push')
  @HttpCode(204)
  push() {
    // Accepted for client compatibility; APNs pushes arrive in Phase 3.
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!UUID.test(id)) throw new SyncError('not_found'); // not a uuid: cannot be one of the user's devices
    await this.devices.revoke(user.id, id);
  }
}
