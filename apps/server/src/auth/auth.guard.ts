import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { AccessClaims, AuthService, DownloadClaims } from './auth.service';
import { ADMIN_ONLY, ALLOW_DT } from './current-user.decorator';
import { DevicesService } from './devices.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.resolve(req, this.reflector.get<boolean>(ALLOW_DT, ctx.getHandler()) === true);
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [ctx.getHandler(), ctx.getClass()])) {
      if (user.role !== 'admin') throw new SyncError('forbidden');
      // A sync device token of an admin only syncs files; it never administers the instance.
      if (user.deviceId) throw new SyncError('forbidden', 'device tokens cannot use admin routes');
    }
    req.user = user;
    return true;
  }

  /**
   * Authenticates a request outside the Nest pipeline (raw Fastify routes such as tus):
   * Bearer JWT or `syd_` device token only. Throws a SyncError when unauthenticated.
   */
  resolveFromHeaders(req: { headers: Record<string, string | string[] | undefined> }): Promise<AuthUser> {
    const authorization = req.headers.authorization;
    return this.resolve({ headers: { authorization: Array.isArray(authorization) ? authorization[0] : authorization } }, false);
  }

  private async resolve(req: { headers: Record<string, string | undefined>; query?: Record<string, string>; params?: Record<string, string> }, allowDt: boolean): Promise<AuthUser> {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer.startsWith('syd_')) {
      const device = await this.devices.authenticate(bearer);
      if (device === 'revoked') throw new SyncError('device_revoked');
      if (!device) throw new SyncError('unauthorized');
      return this.loadUser(device.userId, device.id);
    }
    if (bearer) {
      const claims = await this.auth.verify<AccessClaims>(bearer, 'access');
      if (!claims) throw new SyncError('unauthorized');
      return this.loadUser(claims.sub, null);
    }
    const dt = req.query?.dt;
    if (allowDt && dt) {
      const claims = await this.auth.verify<DownloadClaims>(dt, 'dl');
      if (!claims || claims.item !== req.params?.id) throw new SyncError('unauthorized');
      return this.loadUser(claims.sub, null);
    }
    throw new SyncError('unauthorized');
  }

  private async loadUser(id: string, deviceId: string | null): Promise<AuthUser> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.disabledAt) throw new SyncError('unauthorized');
    return { id: u.id, username: u.username, role: u.role, deviceId };
  }
}
