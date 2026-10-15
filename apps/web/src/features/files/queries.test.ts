import { expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { fetchAllChildren, sortItems } from './queries';

it('follows nextPageToken until exhausted', async () => {
  const spy = vi.spyOn(apiMod, 'api')
    .mockResolvedValueOnce({ items: [{ id: 'a' }], nextPageToken: 't1', cursor: '1' })
    .mockResolvedValueOnce({ items: [{ id: 'b' }], nextPageToken: null, cursor: '1' });
  const items = await fetchAllChildren('root');
  expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(spy.mock.calls[1][0]).toBe('/sync/v1/items/root/children?limit=1000&pageToken=t1');
});

it('sorts folders first, then natural name order', () => {
  const mk = (name: string, type: 'file' | 'folder') => ({ id: name, name, type }) as never;
  expect(sortItems([mk('b10.txt', 'file'), mk('Z', 'folder'), mk('b2.txt', 'file')], 'name', 'asc', 'de').map((i: { name: string }) => i.name))
    .toEqual(['Z', 'b2.txt', 'b10.txt']);
});
