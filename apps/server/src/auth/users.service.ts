import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { PublicUser } from '@synclet/shared';
import * as argon2 from 'argon2';
import { mkdir } from 'node:fs/promises';
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

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Username = folder name below the data root; must be a safe, visible folder name. */
  validateUsername(username: string): void {
    if (validateName(username) !== null || username.startsWith('.') || username !== username.normalize('NFC')) {
      throw new SyncError('invalid_request', 'invalid username');
    }
  }

  async create(input: CreateUserInput): Promise<User> {
    this.validateUsername(input.username);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const user = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findFirst({
        where: { OR: [{ username: { equals: input.username, mode: 'insensitive' } }, ...(input.email ? [{ email: input.email.toLowerCase() }] : [])] },
      });
      if (exists) throw new SyncError('name_conflict', 'username or email already in use');
      const created = await tx.user.create({
        data: { username: input.username, displayName: input.displayName, email: input.email?.toLowerCase() ?? null, role: input.role },
      });
      await tx.identity.create({ data: { userId: created.id, provider: 'local', subject: input.username.toLowerCase(), passwordHash } });
      await tx.syncScope.create({ data: { userId: created.id } });
      return created;
    });
    await mkdir(userRoot(this.config.dataRoot, user.username), { recursive: true }); // adopts an existing folder
    this.events.emit('user.created', { id: user.id, username: user.username });
    return user;
  }

  toPublic(u: User): PublicUser {
    return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role };
  }
}
