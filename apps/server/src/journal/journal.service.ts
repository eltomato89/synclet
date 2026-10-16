import { Injectable } from '@nestjs/common';
import type { ChangeOp, ItemType, Prisma } from '@prisma/client';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';

export type Tx = Prisma.TransactionClient;
export interface ItemRef { id: string; type: ItemType }

@Injectable()
export class JournalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Serializes all mutations of one space's tree (API + indexer). Released at commit/rollback. */
  async lockSpace(tx: Tx, spaceId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}::text, 0))`;
  }

  /** The only writer of `FileChange` rows (API and indexer). */
  async record(tx: Tx, spaceId: string, refs: ItemRef[], op: ChangeOp): Promise<void> {
    const unique = [...new Map(refs.map((r) => [r.id, r])).values()];
    if (unique.length === 0) return;
    const n = unique.length;
    const rows = await tx.$queryRaw<{ seq: bigint }[]>`
      INSERT INTO "SyncScope" ("spaceId", seq, "minSeq") VALUES (${spaceId}::uuid, ${n}, 0)
      ON CONFLICT ("spaceId") DO UPDATE SET seq = "SyncScope".seq + ${n}
      RETURNING seq`;
    const first = rows[0].seq - BigInt(n) + 1n;
    await tx.fileChange.createMany({
      data: unique.map((r, i) => ({ scopeId: spaceId, seq: first + BigInt(i), itemId: r.id, itemType: r.type, op })),
    });
    // Wakes the space's SSE streams (events/change-notifier.ts). Sent on the same transaction:
    // Postgres delivers it only on commit, and a rolled-back transaction delivers nothing.
    await tx.$executeRaw`SELECT pg_notify('synclet_changes', ${spaceId}::text)`;
  }

  async currentCursor(spaceId: string): Promise<string> {
    const scope = await this.prisma.syncScope.findUnique({ where: { spaceId } });
    return String(scope?.seq ?? 0n);
  }

  async changesSince(spaceId: string, cursor: string, limit: number) {
    if (!/^\d{1,19}$/.test(cursor)) throw new SyncError('invalid_request', 'invalid cursor');
    const c = BigInt(cursor);
    const scope = await this.prisma.syncScope.findUnique({ where: { spaceId } });
    const head = scope?.seq ?? 0n;
    if (c < (scope?.minSeq ?? 0n) || c > head) throw new SyncError('cursor_expired');
    const rows = await this.prisma.$queryRaw<{ itemId: string; itemType: ItemType; seq: bigint }[]>`
      SELECT "itemId", "itemType", MAX(seq) AS seq FROM "FileChange"
      WHERE "scopeId" = ${spaceId}::uuid AND seq > ${c}
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
  async trim(spaceId: string, before: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.fileChange.aggregate({ where: { scopeId: spaceId, at: { lt: before } }, _max: { seq: true } });
      if (max._max.seq === null) return 0;
      const res = await tx.fileChange.deleteMany({ where: { scopeId: spaceId, seq: { lte: max._max.seq } } });
      await tx.syncScope.update({ where: { spaceId }, data: { minSeq: max._max.seq } });
      return res.count;
    });
  }
}
