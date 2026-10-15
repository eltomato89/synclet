const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Nextcloud's version buckets (files_versions `Storage::$max_versions_per_interval`): up to
 * `endsAfter` before now, keep at most one version per `step`. The last bucket never ends.
 */
export const RETENTION_BUCKETS: readonly { endsAfter: number; step: number }[] = [
  { endsAfter: 10 * S, step: 2 * S },
  { endsAfter: MIN, step: 10 * S },
  { endsAfter: HOUR, step: MIN },
  { endsAfter: DAY, step: HOUR },
  { endsAfter: 30 * DAY, step: DAY },
  { endsAfter: Infinity, step: 7 * DAY },
];

/**
 * Ids of the versions to keep (a faithful port of Nextcloud's `getAutoExpireList`, in ms).
 * Walks the versions newest first; the newest is always kept. Each further version is kept when
 * it is at least one bucket step older than the last kept one, otherwise it is dropped. The bucket
 * is chosen by the age of the *last kept* version (as Nextcloud does), and when that age crosses
 * a bucket end the next step applies, measured from the last kept version.
 * Ties on `createdAt` are ordered by id so the result is deterministic.
 */
export function selectVersionsToKeep(versions: { id: string; createdAt: Date }[], now: Date): Set<string> {
  const sorted = [...versions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keep = new Set<string>();
  if (sorted.length === 0) return keep;
  const t = now.getTime();
  let bucket = 0;
  let intervalStart = t - RETENTION_BUCKETS[bucket].endsAfter; // versions newer than this are in the bucket
  let prev = sorted[0].createdAt.getTime();
  let next = prev - RETENTION_BUCKETS[bucket].step;
  keep.add(sorted[0].id);
  for (const v of sorted.slice(1)) {
    const at = v.createdAt.getTime();
    for (;;) {
      if (prev > intervalStart) {
        if (at <= next) {
          keep.add(v.id);
          prev = at;
          next = at - RETENTION_BUCKETS[bucket].step;
        }
        break;
      }
      // The last kept version lies beyond this bucket: re-check this version with the next one.
      bucket++;
      next = prev - RETENTION_BUCKETS[bucket].step;
      intervalStart = t - RETENTION_BUCKETS[bucket].endsAfter;
    }
  }
  return keep;
}
