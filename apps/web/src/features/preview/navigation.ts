/** Files QuickLook steps through: the items as currently sorted, folders left out. */
export function quickLookEntries<T extends { type: string }>(sorted: readonly T[]): T[] {
  return sorted.filter((i) => i.type === 'file');
}

/** The neighbour `delta` steps away from `id`, or null at either end (no wrap-around). */
export function stepEntry<T extends { id: string }>(entries: readonly T[], id: string, delta: number): T | null {
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return null;
  return entries[i + delta] ?? null;
}
