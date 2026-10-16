import { Inject, Injectable } from '@nestjs/common';
import { DerivativeJob, DerivativeKind, JobStatus, Prisma } from '@prisma/client';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { absPath, realpathInside } from '../common/paths';
import { PrismaService } from '../prisma/prisma.service';
import { extOf, TEXT_JOB_EXTS, THUMB_EXTS } from './preview-kind';

export const MAX_ATTEMPTS = 3;
/** A `running` job whose worker died is claimable again after this long. */
const STALE_LOCK = "interval '10 minutes'";
/** Retry delay for a job whose source is not readable right now. */
export const DEFER_MS = 15 * 60_000;

export const JOB_EXTS: Record<DerivativeKind, string[]> = { thumb: THUMB_EXTS, text: TEXT_JOB_EXTS };

/**
 * Table-driven derivative queue (ruling 1b-2): one row per (content hash, kind), claimed with
 * `FOR UPDATE SKIP LOCKED`, at most MAX_ATTEMPTS tries. Nothing here is journaled (ruling 1b-1).
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Inserts missing jobs for live hashed files (≤ previewMaxBytes). Returns the number of new rows. */
  async enqueueMissing(limit = 500): Promise<number> {
    let total = 0;
    for (const kind of Object.keys(JOB_EXTS) as DerivativeKind[]) {
      total += await this.prisma.$executeRaw`
        INSERT INTO "DerivativeJob" (sha, kind, status, attempts, "createdAt", "updatedAt")
        SELECT DISTINCT i."contentHash", ${kind}::"DerivativeKind", 'pending'::"JobStatus", 0, now(), now()
        FROM "Item" i
        WHERE i.type = 'file' AND i."deletedAt" IS NULL AND i."contentHash" IS NOT NULL
          AND i.size <= ${BigInt(this.config.previewMaxBytes)}
          AND lower(substring(i.name from '\\.([^.]+)$')) = ANY(${JOB_EXTS[kind]}::text[])
          AND NOT EXISTS (SELECT 1 FROM "DerivativeJob" j WHERE j.sha = i."contentHash" AND j.kind = ${kind}::"DerivativeKind")
        LIMIT ${limit}
        ON CONFLICT DO NOTHING`;
    }
    return total;
  }

  /**
   * Cheap change signal for the enqueue cadence: every journaled mutation (upload, replace,
   * restore, indexer change) bumps a SyncScope sequence, and the table has one row per user.
   */
  async contentSignal(): Promise<string> {
    const [row] = await this.prisma.$queryRaw<{ sig: string }[]>`
      SELECT coalesce(sum(seq), 0)::text || ':' || count(*)::text AS sig FROM "SyncScope"`;
    return row?.sig ?? '';
  }

  /**
   * Claims up to `n` jobs of `kind` (pending and not deferred, or running with a stale lock), oldest
   * first. Stale `running` rows whose attempts are used up (the worker died on them every time,
   * e.g. OOM-killed by a hostile file) are marked `failed` first, so they never stay `running`.
   */
  async claim(kind: DerivativeKind, n: number): Promise<DerivativeJob[]> {
    await this.prisma.$executeRaw`
      UPDATE "DerivativeJob" SET status = 'failed', "lockedAt" = NULL, "updatedAt" = now(),
        "lastError" = 'worker stopped while processing (attempts exhausted)'
      WHERE kind = ${kind}::"DerivativeKind" AND status = 'running'
        AND "lockedAt" < now() - ${Prisma.raw(STALE_LOCK)} AND attempts >= ${MAX_ATTEMPTS}`;
    return this.prisma.$queryRaw<DerivativeJob[]>`
      UPDATE "DerivativeJob" SET status = 'running', "lockedAt" = now(), attempts = attempts + 1, "updatedAt" = now()
      WHERE (sha, kind) IN (
        SELECT sha, kind FROM "DerivativeJob"
        WHERE kind = ${kind}::"DerivativeKind"
          AND ((status = 'pending' AND ("lockedAt" IS NULL OR "lockedAt" <= now()))
            OR (status = 'running' AND "lockedAt" < now() - ${Prisma.raw(STALE_LOCK)}))
          AND attempts < ${MAX_ATTEMPTS}
        ORDER BY "createdAt"
        LIMIT ${n}
        FOR UPDATE SKIP LOCKED)
      RETURNING *`;
  }

  /** Final state of a claimed job. */
  async complete(sha: string, kind: DerivativeKind, status: JobStatus, meta?: Prisma.InputJsonValue, error?: string): Promise<void> {
    await this.prisma.derivativeJob.updateMany({
      where: { sha, kind },
      data: { status, meta: meta ?? Prisma.DbNull, lastError: error?.slice(0, 1000) ?? null, lockedAt: null },
    });
  }

  /** Transient failure: back to `pending` unless the attempts are used up. */
  async retryOrFail(sha: string, kind: DerivativeKind, error: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "DerivativeJob"
      SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed'::"JobStatus" ELSE 'pending'::"JobStatus" END,
          "lastError" = ${error.slice(0, 1000)}, "lockedAt" = NULL, "updatedAt" = now()
      WHERE sha = ${sha} AND kind = ${kind}::"DerivativeKind"`;
  }

  /** Gives a claimed but unstarted job back (graceful shutdown): the attempt does not count. */
  async release(sha: string, kind: DerivativeKind): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "DerivativeJob" SET status = 'pending', attempts = GREATEST(attempts - 1, 0), "lockedAt" = NULL, "updatedAt" = now()
      WHERE sha = ${sha} AND kind = ${kind}::"DerivativeKind" AND status = 'running'`;
  }

  /**
   * The job has no usable source right now (file changed on the host and not re-indexed yet,
   * removed out of band, symlink escape …). If live files still carry the hash, the job goes back
   * to `pending` but is not claimable before `delayMs` (`lockedAt` in the future = "not before");
   * the attempt does not count. Without any live file the row is removed – enqueueMissing
   * re-creates it if the content shows up again. Returns what happened.
   */
  async deferOrDrop(sha: string, kind: DerivativeKind, delayMs = DEFER_MS): Promise<'deferred' | 'dropped'> {
    const live = await this.prisma.item.count({ where: { contentHash: sha, deletedAt: null, type: 'file' } });
    if (!live) {
      await this.prisma.derivativeJob.deleteMany({ where: { sha, kind } });
      return 'dropped';
    }
    await this.prisma.$executeRaw`
      UPDATE "DerivativeJob" SET status = 'pending', attempts = GREATEST(attempts - 1, 0), "updatedAt" = now(),
        "lockedAt" = now() + ${Math.round(delayMs)}::integer * interval '1 millisecond', "lastError" = 'no readable source file'
      WHERE sha = ${sha} AND kind = ${kind}::"DerivativeKind"`;
    return 'deferred';
  }

  /**
   * A live file with content `sha`, resolved inside its owner's root (symlink escapes rejected)
   * and re-verified against the indexed size and mtime. With `kind`, files whose extension
   * qualifies for that kind are preferred (copies of the same bytes may carry other names).
   */
  async sourceFor(sha: string, kind?: DerivativeKind): Promise<{ abs: string; name: string; size: bigint } | null> {
    const rows = await this.prisma.item.findMany({
      where: { contentHash: sha, type: 'file', deletedAt: null },
      include: { space: { select: { rootPath: true } } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    const exts = kind ? JOB_EXTS[kind] : null;
    const ranked = exts ? [...rows.filter((r) => exts.includes(extOf(r.name))), ...rows.filter((r) => !exts.includes(extOf(r.name)))] : rows;
    for (const r of ranked) {
      try {
        const root = r.space.rootPath;
        const abs = await realpathInside(absPath(root, r.path), root);
        const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = await fh.stat({ bigint: true }).finally(() => fh.close());
        if (!st.isFile() || st.size !== r.size || Number(st.mtimeMs) !== r.mtime.getTime()) continue;
        return { abs, name: r.name, size: r.size };
      } catch {
        continue;
      }
    }
    return null;
  }
}
