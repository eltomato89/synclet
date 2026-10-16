import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { SessionRevokeReason, User } from '@prisma/client';
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
/** `s`: space of the item when the token was minted (absent in tokens of older servers = personal). */
export interface DownloadClaims { sub: string; item: string; s?: string; typ: 'dl' }

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

  /**
   * Item-bound token accepted as `?dt=` by routes marked `@AllowDownloadToken` (content, thumbnail).
   * `spaceId` binds it to the item's space; access to that space is checked again on every use.
   */
  async signDownloadToken(userId: string, itemId: string, ttlSeconds: number = DOWNLOAD_TOKEN_TTL_S, spaceId?: string): Promise<string> {
    const claims: DownloadClaims = { sub: userId, item: itemId, typ: 'dl', ...(spaceId ? { s: spaceId } : {}) };
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

  /** Verifies login (username or email) + local password; throws `unauthorized` otherwise. */
  async verifyCredentials(login: string, password: string): Promise<User> {
    const key = login.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { disabledAt: null, OR: [{ email: key }, { username: { equals: login.trim(), mode: 'insensitive' } }] },
      include: { identities: { where: { provider: 'local' } } },
    });
    const hash = user?.identities[0]?.passwordHash;
    // Always run one argon2 verification so unknown/disabled users are not distinguishable by timing.
    const valid = await argon2.verify(hash ?? (await dummyHash()), password).catch(() => false);
    if (!user || !hash || !valid) throw new SyncError('unauthorized', 'invalid credentials');
    return user;
  }

  async login(login: string, password: string, userAgent?: string) {
    const user = await this.verifyCredentials(login, password);
    // Checked only after a valid password, so the rule does not reveal which accounts exist or are admins.
    if (!(await this.sso.isPasswordLoginAllowed(user))) throw new SyncError('password_login_disabled', 'password login is disabled, use single sign-on');
    return this.issueLogin(user, userAgent);
  }

  async refresh(raw: string | undefined, userAgent?: string) {
    if (!raw) throw new SyncError('unauthorized');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!session) throw new SyncError('unauthorized');
    if (session.revokedAt) {
      await this.rejectRevoked(session.userId, session.revokedReason);
    }
    if (session.expiresAt < new Date() || session.user.disabledAt) throw new SyncError('unauthorized');
    // Atomic rotation: only one concurrent caller can flip revokedAt; the loser is treated as reuse.
    const rotated = await this.prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'rotated' } });
    if (rotated.count === 0) {
      const now = await this.prisma.session.findUnique({ where: { id: session.id }, select: { revokedReason: true } });
      await this.rejectRevoked(session.userId, now?.revokedReason ?? null);
    }
    return this.issue(session.user, userAgent);
  }

  /**
   * A revoked refresh token was presented. Reuse of a *rotated* token means it was copied: assume
   * theft and end all sessions of the user. A session ended by its user (logout) or by an admin is
   * just rejected, so an admin revoking one session does not sign the user out everywhere. Rows
   * revoked before the reason was recorded (null) keep the strict rule.
   */
  private async rejectRevoked(userId: string, reason: SessionRevokeReason | null): Promise<never> {
    if (reason === 'rotated' || reason === null) {
      await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'rotated' } });
      throw new SyncError('unauthorized', 'refresh token reuse detected');
    }
    throw new SyncError('unauthorized');
  }

  async logout(raw: string | undefined) {
    if (!raw) return;
    await this.revokeByHash(hashToken(raw));
  }

  /** Ends the session of a refresh token known only by its hash (idempotent). */
  async revokeByHash(tokenHash: string) {
    await this.prisma.session.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
  }
}
