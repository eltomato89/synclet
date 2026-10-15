import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { PublicUser } from '@synclet/shared';
import * as argon2 from 'argon2';
import { access, constants, mkdir } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { validateName } from '../common/names';
import { userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string | null;
  password: string;
  role: 'admin' | 'user';
}

const FORBIDDEN_USERNAME_CHARS = /[@\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
      await tx.syncScope.create({ data: { userId: created.id } });
      return created;
    });
    this.events.emit('user.created', { id: user.id, username: user.username });
    return user;
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

  toPublic(u: User): PublicUser {
    return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role };
  }
}
