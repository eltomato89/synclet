import type { SyncItem } from '@synclet/shared';
import { describe, expect, it } from 'vitest';
import { sortItems } from '@/features/files/queries';
import { quickLookEntries, stepEntry } from './navigation';

const item = (id: string, name: string, size: number, modifiedAt: string, type: 'file' | 'folder' = 'file') =>
  ({ id, name, size, modifiedAt, type }) as SyncItem;

const items = [
  item('f_b', 'b.jpg', 300, '2026-10-01T10:00:00Z'),
  item('d_x', 'Photos', 0, '2026-10-05T10:00:00Z', 'folder'),
  item('f_a', 'a.png', 100, '2026-10-03T10:00:00Z'),
  item('f_c', 'c.pdf', 200, '2026-10-02T10:00:00Z'),
];

/** Steps through the whole list with →, starting at the first file. */
const walk = (sorted: SyncItem[]) => {
  const entries = quickLookEntries(sorted);
  const order = [entries[0].id];
  for (let cur = stepEntry(entries, entries[0].id, 1); cur; cur = stepEntry(entries, cur.id, 1)) order.push(cur.id);
  return order;
};

describe('QuickLook navigation', () => {
  it('follows the current sort order and skips folders', () => {
    expect(walk(sortItems(items, 'name', 'asc', 'en'))).toEqual(['f_a', 'f_b', 'f_c']);
    expect(walk(sortItems(items, 'name', 'desc', 'en'))).toEqual(['f_c', 'f_b', 'f_a']);
    expect(walk(sortItems(items, 'size', 'desc', 'en'))).toEqual(['f_b', 'f_c', 'f_a']);
    expect(walk(sortItems(items, 'modifiedAt', 'desc', 'en'))).toEqual(['f_a', 'f_c', 'f_b']);
  });

  it('stops at both ends instead of wrapping', () => {
    const entries = quickLookEntries(sortItems(items, 'name', 'asc', 'en'));
    expect(stepEntry(entries, 'f_a', -1)).toBeNull();
    expect(stepEntry(entries, 'f_c', 1)).toBeNull();
    expect(stepEntry(entries, 'f_b', -1)?.id).toBe('f_a');
    expect(stepEntry(entries, 'gone', 1)).toBeNull();
  });
});
