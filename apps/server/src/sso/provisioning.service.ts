import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { readdir } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { nameKey, validateName } from '../common/names';
import { SyncError } from '../common/sync-error';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { UsersService } from '../auth/users.service';
import type { SsoPolicy } from './sso-settings.service';

/** Normalized identity asserted by an SSO source (OIDC claims or forward-auth headers). */
export interface SsoClaims {
  /** `oidc:<issuer>` or `forward`. */
  provider: string;
  subject: string;
  email: string | null;
  /** Only a verified email is stored on new users or used for linking. */
  emailVerified: boolean;
  preferredUsername: string | null;
  name: string | null;
  groups: string[];
}

export const MAX_USERNAME_LENGTH = 64;
const FALLBACK_USERNAME = 'user';
// Path/Windows-forbidden characters, controls, whitespace, '@' (looks like an email login), bidi and zero-width characters.
const REPLACE = /[<>:"/\\|?*\u0000-\u001f\u007f@\s‎‏‪-‮⁦-⁩​-‍⁠﻿]+/gu;

/**
 * Username (= folder name) derived from an untrusted claim: NFC, forbidden characters replaced by
 * `-`, leading/trailing dots, dashes and spaces stripped, at most 64 characters, case kept.
 * Reserved, ignored or empty results fall back to `user`.
 */
export function sanitizeUsername(raw: string | null | undefined): string {
  let s = (raw ?? '').normalize('NFC').replace(REPLACE, '-').replace(/-{2,}/g, '-');
  s = trimEdges(s);
  s = trimEdges(Array.from(s).slice(0, MAX_USERNAME_LENGTH).join(''));
  return s && validateName(s) === null ? s : FALLBACK_USERNAME;
}

function trimEdges(s: string): string {
  return s.replace(/^[.\-\s]+/u, '').replace(/[.\-\s]+$/u, '');
}

function withNumber(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${trimEdges(Array.from(base).slice(0, MAX_USERNAME_LENGTH - suffix.length).join(''))}${suffix}`;
}

const intersects = (a: string[], b: string[]) => a.some((g) => b.includes(g));

/** Maps an SSO identity to a local user: existing identity, verified-email link (opt-in) or a new user (JIT). */
@Injectable()
export class ProvisioningService {
  private readonly log = new Logger('SsoProvisioning');

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async resolve(claims: SsoClaims, policy: SsoPolicy): Promise<User> {
    if (!claims.subject) throw new SyncError('unauthorized', 'missing subject');
    // The allowed-groups gate applies on every login only: removing someone from the group blocks
    // new sign-ins, but existing sessions, app logins and device tokens keep working. To cut access
    // immediately an admin disables the user.
    if (policy.allowedGroups.length > 0 && !intersects(claims.groups, policy.allowedGroups)) {
      throw new SyncError('sso_not_allowed', 'not a member of an allowed group');
    }
    const identity = await this.prisma.identity.findUnique({
      where: { provider_subject: { provider: claims.provider, subject: claims.subject } }, include: { user: true },
    });
    if (identity) return this.syncRole(this.active(identity.user), claims, policy);

    const email = normalizeEmail(claims.email);
    if (policy.linkByEmail && claims.emailVerified && email) {
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) {
        this.active(existing);
        const linked = await this.link(existing, claims);
        this.log.log(`linked ${claims.provider} subject to existing user ${linked.username} by verified email`);
        return this.syncRole(linked, claims, policy);
      }
    }
    return this.create(claims, policy, email);
  }

  private active(user: User): User {
    if (user.disabledAt) throw new SyncError('unauthorized', 'account disabled');
    return user;
  }

  private async link(user: User, claims: SsoClaims): Promise<User> {
    try {
      await this.prisma.identity.create({ data: { userId: user.id, provider: claims.provider, subject: claims.subject } });
      return user;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return this.byIdentity(claims); // a concurrent login linked/created it first
    }
  }

  private async byIdentity(claims: SsoClaims): Promise<User> {
    const identity = await this.prisma.identity.findUnique({
      where: { provider_subject: { provider: claims.provider, subject: claims.subject } }, include: { user: true },
    });
    if (!identity) throw new SyncError('unauthorized', 'identity conflict');
    return this.active(identity.user);
  }

  private async create(claims: SsoClaims, policy: SsoPolicy, email: string | null): Promise<User> {
    const role = intersects(claims.groups, policy.adminGroups) ? 'admin' : 'user';
    // Only a verified email that nobody else uses is stored (an unverified one could later be used to link a victim's login).
    const storeEmail = claims.emailVerified && email && !(await this.prisma.user.findUnique({ where: { email } })) ? email : null;
    const base = sanitizeUsername(claims.preferredUsername || email?.split('@')[0] || claims.name || claims.subject);
    const displayName = (claims.name?.trim() || claims.preferredUsername?.trim() || base).slice(0, 100);
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = await this.freeUsername(base);
      try {
        const user = await this.users.createExternal(
          { username, displayName, email: storeEmail, role },
          { provider: claims.provider, subject: claims.subject },
        );
        this.log.log(`provisioned ${role} ${username} from ${claims.provider}`);
        return user;
      } catch (e) {
        if (isUniqueViolation(e)) {
          // The identity may have been created by a concurrent first login of the same subject.
          const again = await this.prisma.identity.findUnique({ where: { provider_subject: { provider: claims.provider, subject: claims.subject } } });
          if (again) return this.byIdentity(claims);
          continue;
        }
        if (e instanceof SyncError && e.code === 'name_conflict') continue; // username raced away
        throw e;
      }
    }
    throw new SyncError('name_conflict', 'could not allocate a username');
  }

  /**
   * First of `base`, `base-2`, `base-3`, … that is neither a username (case-insensitive) nor an
   * existing folder in the data root (a new SSO user must never adopt somebody else's folder).
   */
  private async freeUsername(base: string): Promise<string> {
    const onDisk = new Set((await readdir(this.config.dataRoot).catch(() => [] as string[])).map(nameKey));
    for (let n = 1; n < 10_000; n++) {
      const candidate = withNumber(base, n);
      if (onDisk.has(nameKey(candidate))) continue;
      const taken = await this.prisma.user.findFirst({ where: { username: { equals: candidate, mode: 'insensitive' } }, select: { id: true } });
      if (!taken) return candidate;
    }
    throw new SyncError('name_conflict', 'could not allocate a username');
  }

  /** With admin groups configured, the role follows group membership on every login; the last password admin is never demoted. */
  private async syncRole(user: User, claims: SsoClaims, policy: SsoPolicy): Promise<User> {
    if (policy.adminGroups.length === 0) return user;
    const desired = intersects(claims.groups, policy.adminGroups) ? 'admin' : 'user';
    if (desired === user.role) return user;
    if (desired === 'admin') return this.prisma.user.update({ where: { id: user.id }, data: { role: 'admin' } });
    return this.prisma.$transaction(async (tx) => {
      // Same row locks as the admin API: concurrent demotions cannot both pass the check.
      if (!(await this.users.canRemoveAdmin(tx, user.id))) {
        this.log.warn(`not demoting ${user.username}: last enabled admin with a password (not in an admin group of ${claims.provider})`);
        return tx.user.findUniqueOrThrow({ where: { id: user.id } });
      }
      return tx.user.update({ where: { id: user.id }, data: { role: 'user' } });
    }, TX_OPTS);
  }
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e && /^[^\s@]+@[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
