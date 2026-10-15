import { Injectable } from '@nestjs/common';
import type { ChangeOp, ItemType, Prisma } from '@prisma/client';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';

export type Tx = Prisma.TransactionClient;
export interface ItemRef { id: string; type: ItemType }

@Injectable()
export class JournalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Serializes all mutations of one user's tree (API + indexer). Released at commit/rollback. */
  async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
  }

  async record(tx: Tx, userId: string, refs: ItemRef[], op: ChangeOp): Promise<void> {
    const unique = [...new Map(refs.map((r) => [r.id, r])).values()];
    if (unique.length === 0) return;
    const n = unique.length;
    const rows = await tx.$queryRaw<{ seq: bigint }[]>`
      INSERT INTO "SyncScope" ("userId", seq, "minSeq") VALUES (${userId}::uuid, ${n}, 0)
      ON CONFLICT ("userId") DO UPDATE SET seq = "SyncScope".seq + ${n}
      RETURNING seq`;
    const first = rows[0].seq - BigInt(n) + 1n;
    await tx.fileChange.createMany({
      data: unique.map((r, i) => ({ scopeId: userId, seq: first + BigInt(i), itemId: r.id, itemType: r.type, op })),
    });
  }

  async currentCursor(userId: string): Promise<string> {
    const scope = await this.prisma.syncScope.findUnique({ where: { userId } });
    return String(scope?.seq ?? 0n);
  }

  async changesSince(userId: string, cursor: string, limit: number) {
    if (!/^\d{1,19}$/.test(cursor)) throw new SyncError('invalid_request', 'invalid cursor');
    const c = BigInt(cursor);
    const scope = await this.prisma.syncScope.findUnique({ where: { userId } });
    const head = scope?.seq ?? 0n;
    if (c < (scope?.minSeq ?? 0n) || c > head) throw new SyncError('cursor_expired');
    const rows = await this.prisma.$queryRaw<{ itemId: string; itemType: ItemType; seq: bigint }[]>`
      SELECT "itemId", "itemType", MAX(seq) AS seq FROM "FileChange"
      WHERE "scopeId" = ${userId}::uuid AND seq > ${c}
      GROUP BY "itemId", "itemType"
      ORDER BY MAX(seq)
      LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit);
    const last = entries.length ? entries[entries.length - 1].seq : c;
    const next = hasMore ? last : last > head ? last : head;
    return { entries, cursor: String(next), hasMore };
  }

  /** Deletes journal entries older than `before` and raises the watermark. */
  async trim(userId: string, before: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.fileChange.aggregate({ where: { scopeId: userId, at: { lt: before } }, _max: { seq: true } });
      if (max._max.seq === null) return 0;
      const res = await tx.fileChange.deleteMany({ where: { scopeId: userId, seq: { lte: max._max.seq } } });
      await tx.syncScope.update({ where: { userId }, data: { minSeq: max._max.seq } });
      return res.count;
    });
  }
}
