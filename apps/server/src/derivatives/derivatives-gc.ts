import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DerivedStore } from './derived-store';

const BATCH = 500;
/** `done` thumbnail jobs whose files are checked per maintenance run (random sample). */
const THUMB_SAMPLE = 500;

/**
 * Garbage collection of derivatives (maintenance). A content hash stays live while a live item,
 * a tombstoned item (it may still be paired with a move), a trash manifest entry or an unfinished
 * job references it.
 *
 * Live items are looked up per batch through the partial index `Item_contentHash_idx`
 * (`WHERE "deletedAt" IS NULL`); tombstones and manifest hashes – small sets – are loaded once
 * per run.
 */
@Injectable()
export class DerivativesGc {
  constructor(private readonly prisma: PrismaService, private readonly store: DerivedStore) {}

  /** Hashes referenced by tombstones and trash manifests (old-format manifests carry none). */
  private async offlineShas(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ sha: string }[]>`
      SELECT "contentHash" AS sha FROM "Item" WHERE "deletedAt" IS NOT NULL AND "contentHash" IS NOT NULL
      UNION
      SELECT e->>'contentHash' AS sha
      FROM "TrashEntry" t
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.manifest) = 'array' THEN t.manifest ELSE '[]'::jsonb END) e
      WHERE jsonb_typeof(e) = 'object' AND e->>'contentHash' IS NOT NULL`;
    return new Set(rows.map((r) => r.sha));
  }

  /** The subset of `batch` that is still referenced (`offline` from offlineShas()). */
  async liveShas(batch: string[], offline?: Set<string>): Promise<Set<string>> {
    if (!batch.length) return new Set();
    const off = offline ?? (await this.offlineShas());
    const rows = await this.prisma.$queryRaw<{ sha: string }[]>`
      SELECT DISTINCT "contentHash" AS sha FROM "Item" WHERE "deletedAt" IS NULL AND "contentHash" = ANY(${batch}::text[])
      UNION
      SELECT sha FROM "DerivativeJob" WHERE sha = ANY(${batch}::text[]) AND status IN ('pending', 'running')`;
    const live = new Set(rows.map((r) => r.sha));
    for (const s of batch) if (off.has(s)) live.add(s);
    return live;
  }

  /**
   * A `done` thumbnail job whose files are gone (e.g. `/meta/derived` was deleted by an admin):
   * back to `pending` with fresh attempts, so the worker regenerates it. Only `done` rows are
   * touched (a concurrent worker run is never interfered with). Returns true when a row was reset.
   */
  async requeueThumb(sha: string): Promise<boolean> {
    const n = await this.prisma.derivativeJob.updateMany({
      where: { sha, kind: 'thumb', status: 'done' },
      data: { status: 'pending', attempts: 0, lockedAt: null, lastError: null },
    });
    return n.count > 0;
  }

  /** Checks a random sample of `done` thumbnail jobs and requeues those whose files are missing. */
  async requeueMissingThumbs(sample = THUMB_SAMPLE): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ sha: string }[]>`
      SELECT sha FROM "DerivativeJob" WHERE kind = 'thumb' AND status = 'done' ORDER BY random() LIMIT ${sample}`;
    let requeued = 0;
    for (const { sha } of rows) {
      let ok: boolean;
      try {
        ok = (await this.store.has(this.store.pathFor(sha, 'thumb', 256))) && (await this.store.has(this.store.pathFor(sha, 'thumb', 1024)));
      } catch {
        continue; // not a content hash: never produced by the worker
      }
      if (!ok && (await this.requeueThumb(sha))) requeued++;
    }
    return requeued;
  }

  /**
   * Removes finished job rows of dead hashes, extracted text (ItemText) of dead hashes,
   * unreferenced derivative dirs and stale temp files; then requeues a sample of `done`
   * thumbnail jobs whose files are missing (self-healing after `/meta/derived` was deleted).
   */
  async run(): Promise<{ dirs: number; jobs: number; texts: number; requeued: number }> {
    const offline = await this.offlineShas();
    // Job rows first: a finished row for a dead hash would otherwise claim `thumbnail: true`
    // (and block re-enqueueing) if the same content is uploaded again after its files are gone.
    let jobs = 0;
    let after = '';
    for (;;) {
      const rows = await this.prisma.derivativeJob.findMany({
        where: { sha: { gt: after }, status: { notIn: ['pending', 'running'] } },
        select: { sha: true }, distinct: ['sha'], orderBy: { sha: 'asc' }, take: BATCH,
      });
      if (!rows.length) break;
      const shas = rows.map((r) => r.sha);
      after = shas[shas.length - 1];
      const live = await this.liveShas(shas, offline);
      const dead = shas.filter((s) => !live.has(s));
      if (dead.length) {
        jobs += (await this.prisma.derivativeJob.deleteMany({ where: { sha: { in: dead }, status: { notIn: ['pending', 'running'] } } })).count;
      }
    }
    // Extracted text of content nobody references any more (search joins live items only, so a
    // stale row is never returned – this is about not keeping user content around).
    let texts = 0;
    after = '';
    for (;;) {
      const rows = await this.prisma.itemText.findMany({ where: { sha: { gt: after } }, select: { sha: true }, orderBy: { sha: 'asc' }, take: BATCH });
      if (!rows.length) break;
      const shas = rows.map((r) => r.sha);
      after = shas[shas.length - 1];
      const live = await this.liveShas(shas, offline);
      const dead = shas.filter((s) => !live.has(s));
      if (dead.length) {
        // The finished `text` job goes with its text: if the content shows up again before the
        // next run, enqueueMissing re-creates the job and the text is extracted again (otherwise a
        // `done` row kept by the job pass above would block that forever).
        const [deleted] = await this.prisma.$transaction([
          this.prisma.itemText.deleteMany({ where: { sha: { in: dead } } }),
          this.prisma.derivativeJob.deleteMany({ where: { sha: { in: dead }, kind: 'text', status: { notIn: ['pending', 'running'] } } }),
        ]);
        texts += deleted.count;
      }
    }
    const dirs = await this.store.gc((batch) => this.liveShas(batch, offline), BATCH);
    const requeued = await this.requeueMissingThumbs();
    return { dirs, jobs, texts, requeued };
  }
}
