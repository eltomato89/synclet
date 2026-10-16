import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma, Space } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config';
import { userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

/** Loads spaces for the file index. Personal space: id = User.id, rootPath = <dataRoot>/<username>. */
@Injectable()
export class SpacesRepo implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncPersonalRoots();
  }

  toIndexSpace(row: Pick<Space, 'id' | 'kind' | 'rootPath'>): IndexSpace {
    return { id: row.id, kind: row.kind, rootPath: row.rootPath };
  }

  /** The personal space of `userId` (404 when there is none). */
  async personalFor(userId: string): Promise<IndexSpace> {
    const row = await this.prisma.space.findUnique({ where: { id: userId } });
    if (!row || row.kind !== 'personal' || row.userId !== userId) throw new SyncError('not_found', 'personal space not found');
    return this.toIndexSpace(row);
  }

  async byId(id: string): Promise<IndexSpace | null> {
    const row = await this.prisma.space.findUnique({ where: { id } });
    return row ? this.toIndexSpace(row) : null;
  }

  /** Creates the personal space of a new user; call in the transaction that inserts the user. */
  createPersonal(tx: Prisma.TransactionClient, user: { id: string; username: string }): Promise<Space> {
    return tx.space.create({
      data: { id: user.id, kind: 'personal', name: user.username, rootPath: userRoot(this.config.dataRoot, user.username), userId: user.id },
    });
  }

  /**
   * Personal roots depend on the container config (dataRoot), not on the database: the migration
   * stores '' and every start sets rootPath = <dataRoot>/<username>. Returns the rows changed.
   */
  async syncPersonalRoots(): Promise<number> {
    const rows = await this.prisma.space.findMany({
      where: { kind: 'personal' },
      select: { id: true, rootPath: true, user: { select: { username: true } } },
    });
    let changed = 0;
    for (const r of rows) {
      if (!r.user) continue;
      const root = userRoot(this.config.dataRoot, r.user.username);
      if (r.rootPath === root) continue;
      await this.prisma.space.update({ where: { id: r.id }, data: { rootPath: root } });
      changed++;
    }
    return changed;
  }
}
