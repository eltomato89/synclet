import path from 'node:path';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma, Space } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config';
import { userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

export interface IndexableSpace {
  space: IndexSpace;
  /** For logs (personal: the username). */
  name: string;
  watch: 'auto' | 'off';
  scanIntervalSec: number | null;
  readOnly: boolean;
}

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

  /** Throws on an empty or relative root: disk access must never resolve against the process cwd. */
  toIndexSpace(row: Pick<Space, 'id' | 'kind' | 'rootPath'>): IndexSpace {
    if (!row.rootPath || !path.isAbsolute(row.rootPath)) throw new Error(`space ${row.id} (${row.kind}) has no root path`);
    return { id: row.id, kind: row.kind, rootPath: row.rootPath };
  }

  /**
   * Spaces the indexer works on: personal spaces of enabled users and available team/external
   * spaces (missing ones are never scanned or watched). Ordered by kind, then name.
   */
  async indexable(): Promise<IndexableSpace[]> {
    const rows = await this.prisma.space.findMany({
      where: { OR: [{ kind: 'personal', user: { disabledAt: null } }, { kind: { in: ['team', 'external'] }, status: 'available' }] },
      select: { id: true, kind: true, rootPath: true, name: true, watch: true, scanIntervalSec: true, readOnly: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    const out: IndexableSpace[] = [];
    for (const r of rows) {
      if (!r.rootPath) continue; // personal root not yet synced (only before onModuleInit)
      out.push({ space: this.toIndexSpace(r), name: r.name, watch: r.watch, scanIntervalSec: r.scanIntervalSec, readOnly: r.readOnly });
    }
    return out;
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
