import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DerivedStore } from './derived-store';

/** Manifest entries of trash entries as rows (old-format manifests and non-arrays yield nothing). */
const MANIFEST_HASHES = `
  SELECT e->>'contentHash' AS sha
  FROM "TrashEntry" t
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.manifest) = 'array' THEN t.manifest ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) = 'object'`;

/**
 * Garbage collection of derivatives (maintenance). A content hash stays live while any item row
 * (live or tombstoned – a tombstone may still be paired with a move), any trash manifest entry or
 * an unfinished job references it.
 */
@Injectable()
export class DerivativesGc {
  constructor(private readonly prisma: PrismaService, private readonly store: DerivedStore) {}

  async liveShas(batch: string[]): Promise<Set<string>> {
    if (!batch.length) return new Set();
    const rows = await this.prisma.$queryRawUnsafe<{ sha: string }[]>(`
      SELECT DISTINCT "contentHash" AS sha FROM "Item" WHERE "contentHash" = ANY($1::text[])
      UNION SELECT sha FROM "DerivativeJob" WHERE sha = ANY($1::text[]) AND status IN ('pending', 'running')
      UNION SELECT sha FROM (${MANIFEST_HASHES}) m WHERE sha = ANY($1::text[])`, batch);
    return new Set(rows.map((r) => r.sha));
  }

  /** Removes unreferenced derivative dirs, stale temp files and finished job rows of dead hashes. */
  async run(): Promise<{ dirs: number; jobs: number }> {
    // Job rows first: a finished row for a dead hash would otherwise claim `thumbnail: true`
    // (and block re-enqueueing) if the same content is uploaded again after its files are gone.
    const jobs = await this.prisma.$executeRawUnsafe(`
      DELETE FROM "DerivativeJob" j
      WHERE j.status NOT IN ('pending', 'running')
        AND NOT EXISTS (SELECT 1 FROM "Item" i WHERE i."contentHash" = j.sha)
        AND NOT EXISTS (SELECT 1 FROM (${MANIFEST_HASHES}) m WHERE m.sha = j.sha)`);
    const dirs = await this.store.gc((batch) => this.liveShas(batch));
    return { dirs, jobs };
  }
}
