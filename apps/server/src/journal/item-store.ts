import { Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from './journal.service';

@Injectable()
export class ItemStore {
  constructor(private readonly prisma: PrismaService) {}

  liveChildren(tx: Tx, spaceId: string, parentId: string | null): Promise<Item[]> {
    return tx.item.findMany({ where: { spaceId, parentId, deletedAt: null } });
  }

  getLive(tx: Tx, spaceId: string, id: string): Promise<Item | null> {
    return tx.item.findFirst({ where: { id, spaceId, deletedAt: null } });
  }

  findLiveByPath(tx: Tx, spaceId: string, path: string): Promise<Item | null> {
    return tx.item.findFirst({ where: { spaceId, path, deletedAt: null } });
  }

  liveDescendants(tx: Tx, spaceId: string, path: string): Promise<Item[]> {
    return tx.$queryRaw<Item[]>`
      SELECT * FROM "Item" WHERE "spaceId" = ${spaceId}::uuid AND "deletedAt" IS NULL
      AND left(path, char_length(${path}) + 1) = ${path} || '/'`;
  }

  async rewritePrefix(tx: Tx, spaceId: string, oldPath: string, newPath: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Item" SET path = ${newPath} || substring(path FROM char_length(${oldPath}) + 1), "updatedAt" = now()
      WHERE "spaceId" = ${spaceId}::uuid AND "deletedAt" IS NULL
      AND left(path, char_length(${oldPath}) + 1) = ${oldPath} || '/'`;
  }

  async tombstoneSubtree(tx: Tx, item: Item): Promise<Item[]> {
    const all = item.type === 'folder' ? [item, ...(await this.liveDescendants(tx, item.spaceId, item.path))] : [item];
    await tx.item.updateMany({ where: { id: { in: all.map((i) => i.id) } }, data: { deletedAt: new Date() } });
    return all;
  }

  sameKeySiblings(tx: Tx, spaceId: string, parentId: string | null, keys: string[], excludeIds: Set<string>): Promise<Item[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return tx.item.findMany({
      where: { spaceId, parentId, deletedAt: null, nameKey: { in: keys }, id: { notIn: [...excludeIds] } },
    });
  }

  async purgeTombstones(olderThan: Date): Promise<number> {
    return (await this.prisma.item.deleteMany({ where: { deletedAt: { lt: olderThan } } })).count;
  }
}
