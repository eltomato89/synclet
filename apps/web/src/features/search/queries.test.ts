import { expect, it } from 'vitest';
import { searchUrl } from './queries';

it('searches everywhere, in a folder subtree, or in a whole space', () => {
  expect(searchUrl('a b', null)).toBe('/sync/v1/search?q=a+b&limit=30');
  expect(searchUrl('x', 'd_1')).toBe('/sync/v1/search?q=x&limit=30&folder=d_1');
  // A space root scopes by space (the server's `space=` filter).
  expect(searchUrl('x', 'r_6f1c2b1e-1111-4a2b-8c3d-000000000001')).toBe('/sync/v1/search?q=x&limit=30&space=6f1c2b1e-1111-4a2b-8c3d-000000000001');
});
