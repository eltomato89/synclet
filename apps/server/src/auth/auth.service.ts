import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import type { AuthResponse } from '@synclet/shared';
import * as argon2 from 'argon2';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { SsoSettingsService } from '../sso/sso-settings.service';
import { hashToken, randomToken } from './crypto';
import { ServerConfigService } from './server-config.service';
import { UsersService } from './users.service';

export const REFRESH_COOKIE = 'synclet_refresh';
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const ACCESS_TTL = '15m';
/** Lifetime of a download token (`Content-Disposition: attachment`, consumed at once). */
export const DOWNLOAD_TOKEN_TTL_S = 60;
/** Lifetime of a preview token: `<img>`/`<video>`/`<iframe>` URLs that stay on screen for a while. */
export const PREVIEW_TOKEN_TTL_S = 6 * 3600;

export interface AccessClaims { sub: string; username: string; role: 'admin' | 'user'; typ: 'access' }
export interface DownloadClaims { sub: string; item: string; typ: 'dl' }

let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('synclet-dummy-password', { type: argon2.argon2id });
  return dummyHashPromise;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly serverConfig: ServerConfigService,
    private readonly users: UsersService,
    private readonly sso: SsoSettingsService,
    @Inject(APP_CONFIG) readonly config: AppConfig,
  ) {}

  private async secret() { return (await this.serverConfig.get()).jwtSecret; }

  async signAccess(u: User): Promise<string> {
    const claims: AccessClaims = { sub: u.id, username: u.username, role: u.role, typ: 'access' };
    return this.jwt.signAsync(claims, { secret: await this.secret(), expiresIn: ACCESS_TTL });
  }

  async verify<T extends { typ: string }>(token: string, typ: T['typ']): Promise<T | null> {
    try {
      const claims = await this.jwt.verifyAsync<T>(token, { secret: await this.secret() });
      return claims.typ === typ ? claims : null;
    } catch {
      return null;
    }
  }

  /** Item-bound token accepted as `?dt=` by routes marked `@AllowDownloadToken` (content, thumbnail). */
  async signDownloadToken(userId: string, itemId: string, ttlSeconds: number = DOWNLOAD_TOKEN_TTL_S): Promise<string> {
    const claims: DownloadClaims = { sub: userId, item: itemId, typ: 'dl' };
    return this.jwt.signAsync(claims, { secret: await this.secret(), expiresIn: ttlSeconds });
  }

  async issue(u: User, userAgent?: string): Promise<{ access: AuthResponse; refreshToken: string }> {
    const refreshToken = randomToken('syr_');
    await this.prisma.session.create({
      data: { userId: u.id, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), userAgent },
    });
    return { access: { accessToken: await this.signAccess(u), user: this.users.toPublic(u) }, refreshToken };
  }

  /** Session for a completed login (password, OIDC, forward-auth, setup): records `lastLoginAt`, then `issue()`. */
  async issueLogin(u: User, userAgent?: string): Promise<{ access: AuthResponse; refreshToken: string }> {
    await this.prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
    return this.issue(u, userAgent);
  }

  async login(login: string, password: string, userAgent?: string) {
    const key = login.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { disabledAt: null, OR: [{ email: key }, { username: { equals: login.trim(), mode: 'insensitive' } }] },
      include: { identities: { where: { provider: 'local' } } },
    });
    const hash = user?.identities[0]?.passwordHash;
    // Always run one argon2 verification so unknown/disabled users are not distinguishable by timing.
    const valid = await argon2.verify(hash ?? (await dummyHash()), password).catch(() => false);
    if (!user || !hash || !valid) throw new SyncError('unauthorized', 'invalid credentials');
    // Checked only after a valid password, so the rule does not reveal which accounts exist or are admins.
    if (!(await this.sso.isPasswordLoginAllowed(user))) throw new SyncError('password_login_disabled', 'password login is disabled, use single sign-on');
    return this.issueLogin(user, userAgent);
  }

  async refresh(raw: string | undefined, userAgent?: string) {
    if (!raw) throw new SyncError('unauthorized');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!session) throw new SyncError('unauthorized');
    if (session.revokedAt) {
      // Reuse of a rotated token: assume theft, kill all sessions of this user.
      await this.prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new SyncError('unauthorized', 'refresh token reuse detected');
    }
    if (session.expiresAt < new Date() || session.user.disabledAt) throw new SyncError('unauthorized');
    // Atomic rotation: only one concurrent caller can flip revokedAt; the loser is treated as reuse.
    const rotated = await this.prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (rotated.count === 0) {
      await this.prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new SyncError('unauthorized', 'refresh token reuse detected');
    }
    return this.issue(session.user, userAgent);
  }

  async logout(raw: string | undefined) {
    if (!raw) return;
    await this.prisma.session.updateMany({ where: { tokenHash: hashToken(raw), revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
