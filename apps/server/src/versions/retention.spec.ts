import { selectVersionsToKeep } from './retention';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

/** Versions named by their age (e.g. `9s`), created `age` ms before NOW. */
function run(agesMs: number[], names = agesMs.map(String)): string[] {
  const versions = agesMs.map((a, i) => ({ id: names[i], createdAt: new Date(NOW.getTime() - a) }));
  const keep = selectVersionsToKeep(versions, NOW);
  return names.filter((n) => keep.has(n));
}
const secs = (...s: number[]) => run(s.map((x) => x * S));

describe('selectVersionsToKeep (Nextcloud buckets)', () => {
  it('keeps nothing of nothing', () => {
    expect(selectVersionsToKeep([], NOW).size).toBe(0);
  });

  it('always keeps a single version, however old', () => {
    expect(run([400 * D])).toEqual([String(400 * D)]);
    expect(secs(0)).toEqual(['0']);
  });

  it('within 10 s: two versions 1 s apart keep only the newer', () => {
    expect(secs(1, 2)).toEqual(['1000']);
  });

  it('within 10 s: exactly one step (2 s) apart keeps both (boundary)', () => {
    expect(secs(1, 3)).toEqual(['1000', '3000']);
  });

  it('within 10 s: one version per 2 s', () => {
    expect(secs(0, 1, 2, 3, 4, 5)).toEqual(['0', '2000', '4000']);
  });

  it('many versions within one second keep only the newest', () => {
    expect(run([0, 100, 200, 300, 400, 500, 600, 700, 800, 900])).toEqual(['0']);
  });

  it('the result does not depend on the input order', () => {
    const versions = [3, 0, 5, 1, 4, 2].map((s) => ({ id: `${s}s`, createdAt: new Date(NOW.getTime() - s * S) }));
    expect([...selectVersionsToKeep(versions, NOW)].sort()).toEqual(['0s', '2s', '4s']);
  });

  it('equal timestamps keep exactly one (lowest id)', () => {
    const at = new Date(NOW.getTime() - 5 * S);
    expect([...selectVersionsToKeep([{ id: 'b', createdAt: at }, { id: 'a', createdAt: at }], NOW)]).toEqual(['a']);
  });

  it('switches from the 2 s to the 10 s step once the last kept version is older than 10 s', () => {
    expect(secs(0, 9, 11, 15, 21)).toEqual(['0', '9000', '11000', '21000']);
  });

  it('a last kept version exactly 10 s old already belongs to the next bucket (boundary)', () => {
    // 10 s: 10 s bucket ends -> 1 min bucket (step 10 s) -> 11 s is too close.
    expect(secs(10, 11)).toEqual(['10000']);
    // 9 s is still in the first bucket (2 s step): the next allowed version is 11 s old.
    expect(secs(9, 10)).toEqual(['9000']);
    expect(secs(9, 11)).toEqual(['9000', '11000']);
  });

  it('the bucket follows the age of the last kept version (Nextcloud semantics)', () => {
    // 8 s kept -> still in the 2 s bucket, so 11 s (3 s later) is kept although it is older than 10 s.
    expect(secs(0, 8, 9, 11)).toEqual(['0', '8000', '11000']);
  });

  it('within 1 h: one version per minute', () => {
    expect(secs(60, 90, 119, 120, 150, 180)).toEqual(['60000', '120000', '180000']);
  });

  it('within 24 h: one version per hour', () => {
    expect(run([1 * H, 1.5 * H, 2 * H, 2 * H + 59 * MIN, 3 * H])).toEqual([String(H), String(2 * H), String(3 * H)]);
  });

  it('within 24 h: versions every 10 minutes thin out to one per hour', () => {
    const ages = Array.from({ length: 25 }, (_, i) => (60 + i * 10) * MIN);
    expect(run(ages)).toEqual([60, 120, 180, 240, 300].map((m) => String(m * MIN)));
  });

  it('within 30 days: one version per day', () => {
    expect(run([1 * D, 1.5 * D, 2 * D, 3 * D, 3.5 * D])).toEqual([String(D), String(2 * D), String(3 * D)]);
  });

  it('older than 30 days: one version per week', () => {
    expect(run([30 * D, 31 * D, 37 * D, 44 * D, 50 * D, 51 * D])).toEqual([30, 37, 44, 51].map((d) => String(d * D)));
  });

  it('keeps well spread versions across all buckets', () => {
    const ages = [1 * S, 5 * S, 30 * S, 5 * MIN, 5 * H, 5 * D, 60 * D, 120 * D];
    expect(run(ages)).toEqual(ages.map(String));
  });

  it('a version exactly 30 days old moves the walk into the weekly bucket (boundary)', () => {
    // newest 29 d: daily bucket -> 30 d kept (1 d step); then the last kept is 30 d old -> weekly.
    expect(run([29 * D, 30 * D, 31 * D, 36 * D, 37 * D])).toEqual([29, 30, 37].map((d) => String(d * D)));
  });

  it('versions slightly in the future (clock skew) are handled like fresh ones', () => {
    expect(run([-5 * S, 0])).toEqual([String(-5 * S), '0']);
  });

  it('a burst of saves within one second plus older history keeps the newest of the burst', () => {
    expect(run([0, 300, 600, 2 * H, 2 * H + 1 * S])).toEqual(['0', String(2 * H)]);
  });
});
