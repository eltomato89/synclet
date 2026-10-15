import { Injectable } from '@nestjs/common';
import type { SyncDevice as DeviceRow } from '@prisma/client';
import type { SyncDevice } from '@synclet/shared';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, randomToken } from './crypto';

export interface RegisterDeviceInput {
  name: string;
  platform: SyncDevice['platform'];
  appVersion: string;
  installationId?: string;
}

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(user: AuthUser, input: RegisterDeviceInput): Promise<{ device: DeviceRow; token: string }> {
    const token = randomToken('syd_');
    const device = await this.prisma.$transaction(async (tx) => {
      // Re-registration of the same installation revokes the old device instead of piling up entries.
      await tx.syncDevice.updateMany({
        where: {
          userId: user.id, platform: input.platform, revokedAt: null,
          ...(input.installationId ? { installationId: input.installationId } : { installationId: null, name: input.name }),
        },
        data: { revokedAt: new Date() },
      });
      return tx.syncDevice.create({
        data: { userId: user.id, name: input.name, platform: input.platform, appVersion: input.appVersion, installationId: input.installationId ?? null, tokenHash: hashToken(token) },
      });
    });
    return { device, token };
  }

  list(userId: string): Promise<DeviceRow[]> {
    return this.prisma.syncDevice.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
  }

  async revoke(userId: string, deviceId: string): Promise<void> {
    const res = await this.prisma.syncDevice.updateMany({ where: { id: deviceId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw new SyncError('not_found');
  }

  /** Returns the device for a raw token, or 'revoked'/null. Touches lastSeenAt at most once per minute. */
  async authenticate(token: string): Promise<DeviceRow | 'revoked' | null> {
    const row = await this.prisma.syncDevice.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row) return null;
    if (row.revokedAt) return 'revoked';
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > 60_000) {
      await this.prisma.syncDevice.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
    }
    return row;
  }

  toWire(row: DeviceRow, currentId?: string | null): SyncDevice {
    return {
      id: row.id, name: row.name, platform: row.platform as SyncDevice['platform'], appVersion: row.appVersion,
      createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      ...(currentId !== undefined ? { current: row.id === currentId } : {}),
    };
  }
}
