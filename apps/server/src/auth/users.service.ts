import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import type { PublicUser } from '@synclet/shared';
import * as argon2 from 'argon2';
import { access, constants, lstat, mkdir, readdir } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { isIgnored, validateName } from '../common/names';
import { userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesRepo } from '../spaces/spaces.repo';

export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string | null;
  password: string;
  role: 'admin' | 'user';
  /** Require the folder to exist already (a real directory, not a symlink) and take it over as the user's root. */
  adoptExistingFolder?: boolean;
}

export interface AdminLock { id: string; hasPassword: boolean }

const FORBIDDEN_USERNAME_CHARS = /[@\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly spaces: SpacesRepo,
  ) {}

  /** Username = folder name below the data root; must be a safe, visible folder name. */
  validateUsername(username: string): void {
    // Bidi controls, zero-width characters and '@' (looks like an email login) enable spoofed folder/login names.
    if (validateName(username) !== null || username.startsWith('.') || username !== username.normalize('NFC') || FORBIDDEN_USERNAME_CHARS.test(username)) {
      throw new SyncError('invalid_request', 'invalid username');
    }
  }

  async create(input: CreateUserInput): Promise<User> {
    this.validateUsername(input.username);
    if (input.adoptExistingFolder) await this.assertAdoptable(input.username);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    return this.insert(input, { provider: 'local', subject: input.username.toLowerCase(), passwordHash });
  }

  /**
   * Creates a user that logs in through an external identity (SSO provisioning): user row, sync
   * scope, folder and the given identity, but no local password identity.
   */
  async createExternal(input: Omit<CreateUserInput, 'password'>, identity: { provider: string; subject: string }): Promise<User> {
    this.validateUsername(input.username);
    return this.insert(input, { provider: identity.provider, subject: identity.subject, passwordHash: null });
  }

  private async insert(
    input: Omit<CreateUserInput, 'password'>,
    identity: { provider: string; subject: string; passwordHash: string | null },
  ): Promise<User> {
    await this.ensureUserRoot(input.username); // before the DB write: a failure must not leave a user without a folder
    const user = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findFirst({
        where: { OR: [{ username: { equals: input.username, mode: 'insensitive' } }, ...(input.email ? [{ email: input.email.toLowerCase() }] : [])] },
      });
      if (exists) throw new SyncError('name_conflict', 'username or email already in use');
      const created = await tx.user.create({
        data: { username: input.username, displayName: input.displayName, email: input.email?.toLowerCase() ?? null, role: input.role },
      });
      await tx.identity.create({ data: { userId: created.id, ...identity } });
      await this.spaces.createPersonal(tx, created);
      await tx.syncScope.create({ data: { spaceId: created.id } });
      return created;
    });
    this.events.emit('user.created', { id: user.id, username: user.username });
    return user;
  }

  /** Top-level directories of the data root that no user owns (candidates for `adoptExistingFolder`). */
  async unassignedFolders(): Promise<{ name: string }[]> {
    let names: string[];
    try {
      names = await readdir(this.config.dataRoot);
    } catch {
      return [];
    }
    const taken = new Set((await this.prisma.user.findMany({ select: { username: true } })).map((u) => u.username.toLowerCase()));
    const out: { name: string }[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.') || isIgnored(name) || taken.has(name.toLowerCase())) continue;
      try {
        this.validateUsername(name);
      } catch {
        continue; // cannot be a username, so it cannot be adopted
      }
      const st = await lstat(userRoot(this.config.dataRoot, name)).catch(() => null);
      if (st?.isDirectory()) out.push({ name });
    }
    return out;
  }

  private async assertAdoptable(username: string): Promise<void> {
    const st = await lstat(userRoot(this.config.dataRoot, username)).catch(() => null);
    if (!st?.isDirectory()) throw new SyncError('invalid_request', 'folder to adopt does not exist');
    const taken = await this.prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } });
    if (taken) throw new SyncError('name_conflict', 'folder is already assigned to a user');
  }

  /** Creates (or adopts) the user's folder and verifies that the data root and the folder are writable. */
  private async ensureUserRoot(username: string): Promise<void> {
    const root = userRoot(this.config.dataRoot, username);
    try {
      await access(this.config.dataRoot, constants.W_OK);
      await mkdir(root, { recursive: true }); // adopts an existing folder
      await access(root, constants.W_OK);
    } catch (e) {
      const message = `data folder not writable: ${(e as Error).message}`;
      throw new HttpException({ statusCode: 500, message, code: 'invalid_request' }, 500);
    }
  }

  /**
   * Locks every enabled admin row (`FOR UPDATE`, in id order) and returns them with whether each
   * can log in with a local password. Every demotion/disable/delete of an admin goes through this,
   * so concurrent changes (admin API, SSO role sync) serialize on the same rows.
   */
  async lockAdmins(tx: Prisma.TransactionClient): Promise<AdminLock[]> {
    return tx.$queryRaw<AdminLock[]>`
      SELECT u.id::text AS id,
             EXISTS (SELECT 1 FROM "Identity" i WHERE i."userId" = u.id AND i.provider = 'local' AND i."passwordHash" IS NOT NULL) AS "hasPassword"
      FROM "User" u WHERE u.role = 'admin' AND u."disabledAt" IS NULL ORDER BY u.id FOR UPDATE OF u`;
  }

  /**
   * Last-admin rule: after `userId` stops being an enabled admin, at least one enabled admin with a
   * local password must remain (the emergency path, SYNCLET_SSO_EMERGENCY=1, only restores password
   * login). Locks the admins (see `lockAdmins`); false = the change must be refused. A user that is
   * not an enabled admin (per the locked rows) can always be changed.
   */
  async canRemoveAdmin(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const admins = await this.lockAdmins(tx);
    if (!admins.some((a) => a.id === userId)) return true;
    return admins.some((a) => a.id !== userId && a.hasPassword);
  }

  /** Sets the local password, creating the local identity when the user has none (e.g. SSO-provisioned). */
  setLocalPassword(tx: Prisma.TransactionClient, user: Pick<User, 'id' | 'username'>, passwordHash: string): Promise<void> {
    return setLocalPassword(tx, user, passwordHash);
  }

  toPublic(u: User): PublicUser {
    return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role };
  }
}

/** See `UsersService.setLocalPassword` (also used by the reset-admin-password CLI, outside Nest). */
export async function setLocalPassword(tx: Prisma.TransactionClient, user: Pick<User, 'id' | 'username'>, passwordHash: string): Promise<void> {
  const updated = await tx.identity.updateMany({ where: { userId: user.id, provider: 'local' }, data: { passwordHash } });
  if (updated.count === 0) {
    await tx.identity.create({ data: { userId: user.id, provider: 'local', subject: user.username.toLowerCase(), passwordHash } });
  }
}
