import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Item, ShareLink } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { hashToken } from '../auth/crypto';
import { RateLimiter } from '../auth/rate-limit';
import { ServerConfigService } from '../auth/server-config.service';
import { absPath, userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { APP_CONFIG, AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { parseSyncId, UUID } from '../sync/sync-ids';

/** 32 random bytes, base64url (see `randomToken`). Anything else is rejected before a DB lookup. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const UNLOCK_TTL_SEC = 12 * 3600;
const HKDF_INFO = 'synclet-share-v1';

/** AES-256-GCM key for stored share tokens: HKDF-SHA256(jwtSecret, info "synclet-share-v1"). */
export function shareTokenKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(jwtSecret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32));
}

/**
 * Encrypts a share token as base64url `iv.ciphertext.tag`. The share id is bound as additional
 * authenticated data, so an encrypted token cannot be moved to another share row.
 */
export function encryptToken(key: Buffer, token: string, shareId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(shareId, 'utf8'));
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

export function decryptToken(key: Buffer, enc: string, shareId: string): string {
  const [iv, ct, tag] = enc.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !ct || !tag || iv.length !== 12 || tag.length !== 16) throw new Error('malformed encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(shareId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

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

/**
 * Rate-limit key of a client address: IPv4-mapped IPv6 as plain IPv4, other IPv6 by its /64
 * prefix (one end-user network usually owns a whole /64, so per-address keys are free to rotate).
 */
export function ipKey(ip: string | undefined): string {
  const raw = (ip ?? '').trim().split('%')[0].toLowerCase();
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(':')) return raw;
  const [head, tail] = raw.split('::');
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const all = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - width(h) - width(groups(tail)))).fill('0'), ...groups(tail)];
  const prefix = all.slice(0, 4).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16).toString(16) : '0'));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}

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

/** A share resolved for an anonymous request: the link row, its live root item and the owner. */
export interface ResolvedShare {
  share: ShareLink;
  root: Item;
  owner: IndexUser & { displayName: string };
}

/**
 * Resolution and scoping of public share requests. Every target is checked against the share's
 * root on current DB paths (the share follows the item id across moves) and, on disk, against the
 * real path of the root (a symlink swapped in anywhere below never leads outside).
 */
@Injectable()
export class ShareAuth {
  private key?: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly serverConfig: ServerConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async tokenKey(): Promise<Buffer> {
    this.key ??= shareTokenKey((await this.serverConfig.get()).jwtSecret);
    return this.key;
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

  /** Owner (enabled) and live shared item of an active share; 404 otherwise. No password check. */
  async load(share: ShareLink): Promise<ResolvedShare> {
    const owner = await this.prisma.user.findUnique({ where: { id: share.ownerId } });
    if (!owner || owner.disabledAt) throw new SyncError('not_found');
    const root = await this.prisma.item.findFirst({ where: { id: share.itemId, ownerId: share.ownerId, deletedAt: null } });
    if (!root) throw new SyncError('not_found');
    return { share, root, owner: { id: owner.id, username: owner.username, displayName: owner.displayName } };
  }

  /** True if `item` is the shared item or a descendant of it, on current DB paths. */
  static inScope(rs: ResolvedShare, item: Item): boolean {
    if (item.ownerId !== rs.share.ownerId || item.deletedAt) return false;
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
      item = id === rs.root.id ? rs.root : await this.prisma.item.findFirst({ where: { id, ownerId: rs.share.ownerId, deletedAt: null } });
    }
    if (!item || !ShareAuth.inScope(rs, item)) throw new SyncError('not_found');
    if (type && item.type !== type) throw new SyncError('not_found');
    return item;
  }

  /**
   * Real path of an item, required to be exactly its indexed path below the real user root: no
   * symlink anywhere in the chain (a folder swapped for a symlink on the host, even one pointing
   * elsewhere inside the same user root, is never followed).
   */
  private async canonical(rs: ResolvedShare, item: Item): Promise<string> {
    try {
      const realUser = await realpath(userRoot(this.config.dataRoot, rs.owner.username));
      const real = await realpath(absPath(this.config.dataRoot, rs.owner.username, item.path));
      if (real !== path.join(realUser, ...item.path.split('/'))) throw new Error('symlink in path');
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
