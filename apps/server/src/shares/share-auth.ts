import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Item, ShareLink } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashToken } from '../auth/crypto';
import { RateLimiter } from '../auth/rate-limit';
import { ServerConfigService } from '../auth/server-config.service';
import { SecretBox } from '../common/secret-box';
import { absPath } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexSpace, IndexUser } from '../common/types';
import { APP_CONFIG, AppConfig } from '../config';
import { SpaceAccess } from '../spaces/space-access.service';
import { SpacesRepo } from '../spaces/spaces.repo';
import { PrismaService } from '../prisma/prisma.service';
import { parseSyncId, UUID } from '../sync/sync-ids';

/** 32 random bytes, base64url (see `randomToken`). Anything else is rejected before a DB lookup. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const UNLOCK_TTL_SEC = 12 * 3600;

/** SecretBox purpose of stored share tokens (HKDF info); the share id is the AAD. */
export const SHARE_TOKEN_PURPOSE = 'synclet-share-v1';

/** Item id as sent by clients: a sync id (`d_…`/`f_…`) or a bare uuid. */
export function parseItemId(raw: string | undefined): string | null {
  const id = (raw ?? '').trim();
  if (UUID.test(id)) return id;
  const parsed = parseSyncId(id);
  return parsed && parsed.kind !== 'root' ? parsed.uuid : null;
}

export const unlockCookieName = (shareId: string) => `synclet_share_${shareId}`;

interface UnlockClaims { typ: 'share'; sid: string; pw: string }

/** Binds an unlock to the current password: changing the password invalidates earlier unlocks. */
const passwordStamp = (passwordHash: string) => createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);

type LimitName = 'requests' | 'unlock' | 'unlockShare' | 'upload';
/** Seconds until one token is back, sent as Retry-After. */
const RETRY_AFTER: Record<LimitName, number> = { requests: 1, unlock: 10, unlockShare: 30, upload: 180 };

/** Rate limits of the anonymous share API. Fields are replaceable (tests). */
@Injectable()
export class ShareRateLimits {
  /** Every public request, per client: generous (a folder view loads many thumbnails). */
  requests = new RateLimiter({ capacity: 600, refillPerSec: 20 });
  /** Password checks per client: same budget as login (5 burst, one more per 10 s). */
  unlock = new RateLimiter({ capacity: 5, refillPerSec: 1 / 10 });
  /** Password checks per share (key `unlock:<shareId>`), whatever the number of clients. */
  unlockShare = new RateLimiter({ capacity: 20, refillPerSec: 1 / 30 });
  /** External uploads per client: 20 per hour. */
  upload = new RateLimiter({ capacity: 20, refillPerSec: 20 / 3600 });

  /** Takes one token of limit `name` for `key` or throws 429 rate_limited with Retry-After. */
  take(name: LimitName, key: string, reply: FastifyReply): void {
    if (this[name].take(key)) return;
    reply.header('Retry-After', String(RETRY_AFTER[name]));
    throw new SyncError('rate_limited', 'too many requests, try again later');
  }
}

/** A share resolved for an anonymous request: the link row, its live root item, its space and the owner. */
export interface ResolvedShare {
  share: ShareLink;
  root: Item;
  space: IndexSpace;
  owner: IndexUser & { displayName: string };
}

/**
 * Resolution and scoping of public share requests. Every target is checked against the share's
 * root on current DB paths (the share follows the item id across moves) and, on disk, against the
 * real path of the root (a symlink swapped in anywhere below never leads outside).
 */
@Injectable()
export class ShareAuth {
  private box?: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly serverConfig: ServerConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly spaces: SpacesRepo,
    private readonly access: SpaceAccess,
  ) {}

  private async secretBox(): Promise<SecretBox> {
    this.box ??= new SecretBox((await this.serverConfig.get()).jwtSecret);
    return this.box;
  }

  /** Encrypts a share token for storage; the share id is bound as AAD (not movable to another row). */
  async sealToken(token: string, shareId: string): Promise<string> {
    return (await this.secretBox()).seal(token, SHARE_TOKEN_PURPOSE, shareId);
  }

  async openToken(enc: string, shareId: string): Promise<string> {
    return (await this.secretBox()).open(enc, SHARE_TOKEN_PURPOSE, shareId);
  }

  /** Link for the owner: absolute with SYNCLET_PUBLIC_URL, else `/s/<token>`. */
  url(token: string): string {
    const base = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : '';
    return `${base}/s/${token}`;
  }

  async signUnlock(share: ShareLink): Promise<string> {
    const claims: UnlockClaims = { typ: 'share', sid: share.id, pw: passwordStamp(share.passwordHash ?? '') };
    return this.jwt.signAsync(claims, { secret: (await this.serverConfig.get()).jwtSecret, expiresIn: UNLOCK_TTL_SEC });
  }

  private async unlocked(req: FastifyRequest, share: ShareLink): Promise<boolean> {
    const raw = req.cookies?.[unlockCookieName(share.id)];
    if (!raw) return false;
    try {
      const c = await this.jwt.verifyAsync<UnlockClaims>(raw, { secret: (await this.serverConfig.get()).jwtSecret });
      return c.typ === 'share' && c.sid === share.id && c.pw === passwordStamp(share.passwordHash ?? '');
    } catch {
      return false;
    }
  }

  /** Link row by token: unknown and revoked are both 404, expired is 410. */
  async findActive(token: string): Promise<ShareLink> {
    if (!SHARE_TOKEN.test(token)) throw new SyncError('not_found');
    const share = await this.prisma.shareLink.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!share || share.revokedAt) throw new SyncError('not_found');
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) throw new SyncError('share_expired');
    return share;
  }

  /** Full resolution of a public request (404 / 410 / 401 share_password_required / 404). */
  async resolve(token: string, req: FastifyRequest): Promise<ResolvedShare> {
    const share = await this.findActive(token);
    if (share.passwordHash && !(await this.unlocked(req, share))) throw new SyncError('share_password_required');
    return this.load(share);
  }

  /**
   * Owner and live shared item of an active share; 404 otherwise. No password check. A link is
   * only valid while its creator is enabled and still has write in the share's space (an available
   * one): losing either makes it answer like a revoked link, regaining it re-activates it.
   */
  async load(share: ShareLink): Promise<ResolvedShare> {
    const owner = await this.prisma.user.findUnique({ where: { id: share.ownerId } });
    if (!owner || owner.disabledAt) throw new SyncError('not_found');
    const row = await this.prisma.space.findUnique({ where: { id: share.spaceId } });
    if (!row || row.status !== 'available' || (await this.access.roleFor(owner, row)) !== 'write') throw new SyncError('not_found');
    const space = this.spaces.toIndexSpace(row);
    const root = await this.prisma.item.findFirst({ where: { id: share.itemId, spaceId: share.spaceId, deletedAt: null } });
    if (!root) throw new SyncError('not_found');
    return { share, root, space, owner: { id: owner.id, username: owner.username, displayName: owner.displayName } };
  }

  /** True if `item` is the shared item or a descendant of it, on current DB paths. */
  static inScope(rs: ResolvedShare, item: Item): boolean {
    if (item.spaceId !== rs.share.spaceId || item.deletedAt) return false;
    if (item.id === rs.root.id) return true;
    return rs.root.type === 'folder' && item.path.startsWith(rs.root.path + '/');
  }

  /**
   * A live item inside the share by client id (`undefined`/empty = the shared item itself).
   * Anything outside the share, of another user, trashed or malformed is 404.
   */
  async target(rs: ResolvedShare, rawId: string | undefined, type?: 'folder' | 'file'): Promise<Item> {
    let item: Item | null = rs.root;
    if (rawId !== undefined && rawId !== '') {
      const id = parseItemId(rawId);
      if (!id) throw new SyncError('not_found');
      item = id === rs.root.id ? rs.root : await this.prisma.item.findFirst({ where: { id, spaceId: rs.share.spaceId, deletedAt: null } });
    }
    if (!item || !ShareAuth.inScope(rs, item)) throw new SyncError('not_found');
    if (type && item.type !== type) throw new SyncError('not_found');
    return item;
  }

  /**
   * Real path of an item, required to be exactly its indexed path below the real space root: no
   * symlink anywhere in the chain (a folder swapped for a symlink on the host, even one pointing
   * elsewhere inside the same space root, is never followed).
   */
  private async canonical(rs: ResolvedShare, item: Item): Promise<string> {
    try {
      const realSpace = await realpath(rs.space.rootPath);
      const real = await realpath(absPath(rs.space.rootPath, item.path));
      if (real !== path.join(realSpace, ...item.path.split('/'))) throw new Error('symlink in path');
      return real;
    } catch {
      throw new SyncError('not_found');
    }
  }

  /** Real path of the shared root (see `canonical`). */
  realRoot(rs: ResolvedShare): Promise<string> {
    return this.canonical(rs, rs.root);
  }

  /** Real path of an in-scope item; canonical and inside the real path of the shared root. */
  async realPathOf(rs: ResolvedShare, item: Item, realRoot?: string): Promise<string> {
    const rootReal = realRoot ?? (await this.realRoot(rs));
    const real = await this.canonical(rs, item);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new SyncError('not_found');
    return real;
  }
}
